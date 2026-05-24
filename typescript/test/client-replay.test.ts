import { describe, expect, it, vi } from "vitest";
import { AtlaSentClient } from "../src/client.js";

function makeClient(fetchImpl: typeof fetch) {
  return new AtlaSentClient({
    apiKey: "ask_test_abc123",
    baseUrl: "https://api.atlasent.io",
    fetch: fetchImpl,
    retryPolicy: { maxAttempts: 1 },
  });
}

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}): typeof fetch {
  return vi.fn().mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    }),
  ) as unknown as typeof fetch;
}

const EVAL_ID = "00000000-0000-0000-0000-000000000001";
const RL_HEADERS = {
  "x-ratelimit-limit": "100",
  "x-ratelimit-remaining": "99",
  "x-ratelimit-reset": "9999999999",
};

describe("AtlaSentClient.replay()", () => {
  it("NONE variance — no drift, allow→allow", async () => {
    const fetch = mockFetch(200, {
      decision_id: EVAL_ID,
      original_decision: "allow",
      replay_decision: "allow",
      engine_version: "opa@0.61.0",
      engine_version_kind: "active",
      accepts_replay: true,
      variance: "NONE",
      envelope_verification: "verified",
      replayed_at: "2026-05-24T00:00:00.000Z",
    }, RL_HEADERS);
    const result = await makeClient(fetch).replay({ evaluationId: EVAL_ID });
    expect(result.varianceKind).toBe("NONE");
    expect(result.originalDecision).toBe("allow");
    expect(result.replayedDecision).toBe("allow");
    expect(result.decisionId).toBe(EVAL_ID);
    expect(result.acceptsReplay).toBe(true);
    expect(result.engineVersion).toBe("opa@0.61.0");
    expect(result.envelopeVerification).toBe("verified");
    expect(result.rateLimit?.remaining).toBe(99);
  });

  it("DECISION_CHANGED wire → POLICY_DRIFT SDK", async () => {
    const fetch = mockFetch(200, {
      decision_id: EVAL_ID,
      original_decision: "allow",
      replay_decision: "deny",
      replay_deny_code: "DENY_POLICY",
      engine_version: "opa@0.61.0",
      engine_version_kind: "active",
      accepts_replay: true,
      variance: "DECISION_CHANGED",
      envelope_verification: "verified",
      replayed_at: "2026-05-24T00:00:00.000Z",
    });
    const result = await makeClient(fetch).replay({ evaluationId: EVAL_ID });
    expect(result.varianceKind).toBe("POLICY_DRIFT");
    expect(result.replayedDecision).toBe("deny");
    expect(result.replayedDenyCode).toBe("DENY_POLICY");
  });

  it("ENVELOPE_DRIFT — no replayedDecision in response", async () => {
    const fetch = mockFetch(200, {
      decision_id: EVAL_ID,
      original_decision: "deny",
      original_deny_code: "DENY_ENVIRONMENT",
      engine_version_kind: "active",
      accepts_replay: true,
      variance: "ENVELOPE_DRIFT",
      envelope_verification: "drift",
      replayed_at: "2026-05-24T00:00:00.000Z",
    });
    const result = await makeClient(fetch).replay({ evaluationId: EVAL_ID });
    expect(result.varianceKind).toBe("ENVELOPE_DRIFT");
    expect(result.replayedDecision).toBeUndefined();
    expect(result.originalDenyCode).toBe("DENY_ENVIRONMENT");
    expect(result.envelopeVerification).toBe("drift");
  });

  it("409 with 'engine' in message → ENGINE_DRIFT, does not throw", async () => {
    const fetch = mockFetch(409, {
      error: "replay_not_eligible",
      message: "engine version opa@0.55.0 is retired and cannot replay",
    });
    const result = await makeClient(fetch).replay({ evaluationId: EVAL_ID });
    expect(result.varianceKind).toBe("ENGINE_DRIFT");
    expect(result.acceptsReplay).toBe(false);
    expect(result.decisionId).toBe(EVAL_ID);
    expect(result.rateLimit).toBeNull();
  });

  it("409 with 'bundle' in message → BUNDLE_MISSING, does not throw", async () => {
    const fetch = mockFetch(409, {
      error: "replay_not_eligible",
      message: "no policy bundle recorded for this decision",
    });
    const result = await makeClient(fetch).replay({ evaluationId: EVAL_ID });
    expect(result.varianceKind).toBe("BUNDLE_MISSING");
    expect(result.acceptsReplay).toBe(false);
  });

  it("builds correct POST URL path", async () => {
    const mockFn = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        decision_id: EVAL_ID,
        original_decision: "allow",
        accepts_replay: true,
        variance: "NONE",
        replayed_at: new Date().toISOString(),
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ) as unknown as typeof fetch;
    await makeClient(mockFn).replay({ evaluationId: EVAL_ID });
    const [url] = (mockFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe(`https://api.atlasent.io/v1/decisions/${EVAL_ID}/replay`);
  });

  it("uses POST method", async () => {
    const mockFn = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        decision_id: EVAL_ID,
        original_decision: "allow",
        accepts_replay: true,
        variance: "NONE",
        replayed_at: new Date().toISOString(),
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ) as unknown as typeof fetch;
    await makeClient(mockFn).replay({ evaluationId: EVAL_ID });
    const [, init] = (mockFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
  });

  it("parses rate-limit headers from replay response", async () => {
    const fetch = mockFetch(200, {
      decision_id: EVAL_ID,
      original_decision: "allow",
      accepts_replay: true,
      variance: "NONE",
      replayed_at: "2026-05-24T00:00:00.000Z",
    }, {
      "x-ratelimit-limit": "500",
      "x-ratelimit-remaining": "42",
      "x-ratelimit-reset": "1716508800",
    });
    const result = await makeClient(fetch).replay({ evaluationId: EVAL_ID });
    expect(result.rateLimit?.limit).toBe(500);
    expect(result.rateLimit?.remaining).toBe(42);
  });

  it("falls back to evaluationId when decision_id absent in response", async () => {
    const fetch = mockFetch(200, {
      original_decision: "allow",
      accepts_replay: true,
      variance: "NONE",
      replayed_at: "2026-05-24T00:00:00.000Z",
    });
    const result = await makeClient(fetch).replay({ evaluationId: EVAL_ID });
    expect(result.decisionId).toBe(EVAL_ID);
  });
});
