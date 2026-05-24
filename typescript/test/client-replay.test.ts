// Tests for AtlaSentClient.replay() — ADR-015 Phase C SDK-canonical runtime.
//
// Restores coverage that was supposed to land with PR #275 but was dropped
// from its squash merge. The 2.7.0 raw-wire surface (replayDecision()) has
// its own coverage in client.test.ts.

import { describe, expect, it, vi, type MockedFunction } from "vitest";
import { AtlaSentClient, AtlaSentError } from "../src/index.js";

type FetchMock = MockedFunction<typeof fetch>;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function mockFetch(
  impl: (url: string, init: RequestInit) => Response | Promise<Response>,
): FetchMock {
  return vi.fn(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      return impl(url, init ?? {});
    },
  ) as unknown as FetchMock;
}

function makeClient(fetchImpl: FetchMock) {
  return new AtlaSentClient({
    apiKey: "ask_live_test",
    fetch: fetchImpl,
    timeoutMs: 5_000,
    retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
  });
}

describe("client.replay() — SDK-canonical Phase C surface", () => {
  const BASE_WIRE = {
    decision_id: "dec_abc",
    original_decision: "allow",
    replay_decision: "allow",
    engine_version: "wire-v1@1.0.0",
    engine_version_kind: "active",
    accepts_replay: true,
    variance: "NONE",
    envelope_verification: "verified",
    replayed_at: "2026-05-24T00:00:00Z",
  };

  it("POSTs to /v1/decisions/:id/replay with an empty body and returns NONE", async () => {
    const fetchImpl = mockFetch((url, init) => {
      expect(url).toMatch(/\/v1\/decisions\/dec_abc\/replay$/);
      expect(init.method).toBe("POST");
      expect(init.body).toBe("{}");
      return jsonResponse(BASE_WIRE);
    });
    const client = makeClient(fetchImpl);
    const result = await client.replay({ evaluationId: "dec_abc" });

    expect(result.decisionId).toBe("dec_abc");
    expect(result.varianceKind).toBe("NONE");
    expect(result.originalDecision).toBe("allow");
    expect(result.replayedDecision).toBe("allow");
    expect(result.engineVersionKind).toBe("active");
    expect(result.envelopeVerification).toBe("verified");
    expect(result.acceptsReplay).toBe(true);
    expect(result.rateLimit).toBeNull();
  });

  it("maps wire DECISION_CHANGED → SDK-canonical POLICY_DRIFT", async () => {
    const wire = {
      ...BASE_WIRE,
      original_decision: "allow",
      replay_decision: "deny",
      replay_deny_code: "policy.expired_consent",
      variance: "DECISION_CHANGED",
    };
    const client = makeClient(mockFetch(() => jsonResponse(wire)));
    const result = await client.replay({ evaluationId: "dec_abc" });

    expect(result.varianceKind).toBe("POLICY_DRIFT");
    expect(result.originalDecision).toBe("allow");
    expect(result.replayedDecision).toBe("deny");
    expect(result.replayedDenyCode).toBe("policy.expired_consent");
  });

  it("surfaces ENVELOPE_DRIFT without a replayed_decision", async () => {
    const wire = {
      decision_id: "dec_abc",
      original_decision: "allow",
      engine_version: "wire-v1@1.0.0",
      engine_version_kind: "active",
      accepts_replay: true,
      variance: "ENVELOPE_DRIFT",
      envelope_verification: "drift",
      replayed_at: "2026-05-24T00:00:00Z",
    };
    const client = makeClient(mockFetch(() => jsonResponse(wire)));
    const result = await client.replay({ evaluationId: "dec_abc" });

    expect(result.varianceKind).toBe("ENVELOPE_DRIFT");
    expect(result.envelopeVerification).toBe("drift");
    expect(result.replayedDecision).toBeUndefined();
  });

  it("forward-compat: unknown wire variance kinds default to NONE", async () => {
    const wire = { ...BASE_WIRE, variance: "SOMETHING_NEW" };
    const client = makeClient(mockFetch(() => jsonResponse(wire)));
    const result = await client.replay({ evaluationId: "dec_abc" });
    expect(result.varianceKind).toBe("NONE");
  });

  it("409 with 'engine' message → returns ENGINE_DRIFT (does not throw)", async () => {
    const fetchImpl = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            error: "replay_not_eligible",
            message: "Engine version wire-v0@0.9.0 does not accept replay",
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
    );
    const client = makeClient(fetchImpl);
    const result = await client.replay({ evaluationId: "dec_abc" });

    expect(result.varianceKind).toBe("ENGINE_DRIFT");
    expect(result.acceptsReplay).toBe(false);
    expect(result.originalDecision).toBe("deny");
  });

  it("409 with 'bundle' message → returns BUNDLE_MISSING (does not throw)", async () => {
    const fetchImpl = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            error: "replay_not_eligible",
            message: "No policy bundle recorded for this decision",
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
    );
    const client = makeClient(fetchImpl);
    const result = await client.replay({ evaluationId: "dec_abc" });

    expect(result.varianceKind).toBe("BUNDLE_MISSING");
    expect(result.acceptsReplay).toBe(false);
  });

  it("URL-encodes evaluationId", async () => {
    const fetchImpl = mockFetch((url) => {
      expect(url).toMatch(/\/v1\/decisions\/odd%3Aid\/replay$/);
      return jsonResponse({ ...BASE_WIRE, decision_id: "odd:id" });
    });
    const client = makeClient(fetchImpl);
    await client.replay({ evaluationId: "odd:id" });
  });

  it("rejects empty / missing evaluationId without issuing a request", async () => {
    const fetchImpl = mockFetch(() => {
      throw new Error("fetch should not be called");
    });
    const client = makeClient(fetchImpl);
    await expect(client.replay({ evaluationId: "" })).rejects.toMatchObject({
      code: "bad_request",
    });
    // @ts-expect-error — runtime guard for non-string input
    await expect(client.replay({})).rejects.toMatchObject({ code: "bad_request" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces rateLimit from response headers", async () => {
    const fetchImpl = mockFetch(
      () =>
        new Response(JSON.stringify(BASE_WIRE), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-RateLimit-Limit": "100",
            "X-RateLimit-Remaining": "99",
            "X-RateLimit-Reset": "1714070000",
          },
        }),
    );
    const client = makeClient(fetchImpl);
    const result = await client.replay({ evaluationId: "dec_abc" });
    expect(result.rateLimit).toEqual({
      limit: 100,
      remaining: 99,
      resetAt: new Date(1_714_070_000 * 1000),
    });
  });

  it("propagates non-409 errors (e.g. 500) as AtlaSentError", async () => {
    const fetchImpl = mockFetch(
      () =>
        new Response(JSON.stringify({ error: "internal_error" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const client = makeClient(fetchImpl);
    await expect(client.replay({ evaluationId: "dec_abc" })).rejects.toBeInstanceOf(
      AtlaSentError,
    );
  });
});
