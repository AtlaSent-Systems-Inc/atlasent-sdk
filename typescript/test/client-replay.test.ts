/**
 * Tests for AtlaSentClient.replay() — ADR-015 Phase C.
 *
 * client.replay() calls POST /v1/decisions/:id/replay and returns a
 * ReplayResponse with varianceKind from the closed set defined in
 * POLICY_PARITY_CONTRACT.md §Replay.
 */

import { describe, expect, it, vi } from "vitest";
import { AtlaSentClient, AtlaSentError } from "../src/index.js";
import type { ReplayResponse } from "../src/index.js";

const API_KEY = "ask_live_test_key";
const EVAL_ID = "00000000-0000-0000-0000-000000000001";

function makeClient(fetchImpl: typeof fetch) {
  return new AtlaSentClient({
    apiKey: API_KEY,
    fetch: fetchImpl,
    timeoutMs: 5_000,
    retryPolicy: { maxAttempts: 1 },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("client.replay()", () => {
  it("returns NONE when replay decision matches original", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        decision_id: EVAL_ID,
        original_decision: "allow",
        replay_decision: "allow",
        engine_version: "wire-v1@1.4.0",
        engine_version_kind: "active",
        accepts_replay: true,
        variance: "NONE",
        envelope_verification: "verified",
        replayed_at: "2026-05-24T12:00:00.000Z",
      }),
    ) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    const result = await client.replay({ evaluationId: EVAL_ID });

    expect(result.varianceKind).toBe("NONE");
    expect(result.originalDecision).toBe("allow");
    expect(result.replayedDecision).toBe("allow");
    expect(result.acceptsReplay).toBe(true);
    expect(result.decisionId).toBe(EVAL_ID);
    expect(result.envelopeVerification).toBe("verified");
  });

  it("maps DECISION_CHANGED wire variance to POLICY_DRIFT", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        decision_id: EVAL_ID,
        original_decision: "allow",
        replay_decision: "deny",
        replay_deny_code: "DENY_POLICY",
        engine_version: "wire-v1@1.4.0",
        engine_version_kind: "active",
        accepts_replay: true,
        variance: "DECISION_CHANGED",
        envelope_verification: "verified",
        replayed_at: "2026-05-24T12:00:00.000Z",
      }),
    ) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    const result = await client.replay({ evaluationId: EVAL_ID });

    expect(result.varianceKind).toBe("POLICY_DRIFT");
    expect(result.originalDecision).toBe("allow");
    expect(result.replayedDecision).toBe("deny");
    expect(result.replayedDenyCode).toBe("DENY_POLICY");
  });

  it("returns ENVELOPE_DRIFT when envelope verification failed", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        decision_id: EVAL_ID,
        original_decision: "allow",
        engine_version: "wire-v1@1.4.0",
        engine_version_kind: "active",
        accepts_replay: true,
        variance: "ENVELOPE_DRIFT",
        envelope_verification: "drift",
        replayed_at: "2026-05-24T12:00:00.000Z",
      }),
    ) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    const result = await client.replay({ evaluationId: EVAL_ID });

    expect(result.varianceKind).toBe("ENVELOPE_DRIFT");
    expect(result.replayedDecision).toBeUndefined();
    expect(result.envelopeVerification).toBe("drift");
  });

  it("returns ENGINE_DRIFT for 409 engine version not eligible", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          error: "replay_not_eligible",
          message: "Engine version wire-v1@0.9.0 does not accept replay (kind: retired)",
        },
        409,
      ),
    ) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    const result = await client.replay({ evaluationId: EVAL_ID });

    expect(result.varianceKind).toBe("ENGINE_DRIFT");
    expect(result.acceptsReplay).toBe(false);
    expect(result.rateLimit).toBeNull();
  });

  it("returns BUNDLE_MISSING for 409 no policy bundle recorded", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {
          error: "replay_not_eligible",
          message: "No policy bundle recorded for this decision — cannot deterministically replay",
        },
        409,
      ),
    ) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    const result = await client.replay({ evaluationId: EVAL_ID });

    expect(result.varianceKind).toBe("BUNDLE_MISSING");
    expect(result.acceptsReplay).toBe(false);
  });

  it("posts to the correct URL path", async () => {
    let capturedUrl = "";
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      capturedUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      return jsonResponse({
        decision_id: EVAL_ID,
        original_decision: "deny",
        engine_version: "wire-v1@1.4.0",
        engine_version_kind: "active",
        accepts_replay: true,
        variance: "NONE",
        envelope_verification: "absent",
        replayed_at: "2026-05-24T12:00:00.000Z",
      });
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    await client.replay({ evaluationId: EVAL_ID });

    expect(capturedUrl).toMatch(
      new RegExp(`/v1/decisions/${EVAL_ID}/replay$`),
    );
  });

  it("uses POST method", async () => {
    let capturedMethod = "";
    const fetchImpl = vi.fn(
      async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        capturedMethod = init?.method ?? "";
        return jsonResponse({
          decision_id: EVAL_ID,
          original_decision: "deny",
          engine_version: "wire-v1@1.4.0",
          engine_version_kind: "active",
          accepts_replay: true,
          variance: "NONE",
          envelope_verification: "absent",
          replayed_at: "2026-05-24T12:00:00.000Z",
        });
      },
    ) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    await client.replay({ evaluationId: EVAL_ID });

    expect(capturedMethod).toBe("POST");
  });

  it("propagates non-409 errors", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: "invalid_api_key" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    await expect(client.replay({ evaluationId: EVAL_ID })).rejects.toBeInstanceOf(
      AtlaSentError,
    );
  });

  it("parses rate-limit headers from 200 response", async () => {
    const resetEpoch = Math.floor(Date.now() / 1000) + 60;
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          decision_id: EVAL_ID,
          original_decision: "allow",
          replay_decision: "allow",
          engine_version: "wire-v1@1.4.0",
          engine_version_kind: "active",
          accepts_replay: true,
          variance: "NONE",
          envelope_verification: "verified",
          replayed_at: "2026-05-24T12:00:00.000Z",
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-RateLimit-Limit": "1000",
            "X-RateLimit-Remaining": "998",
            "X-RateLimit-Reset": String(resetEpoch),
          },
        },
      ),
    ) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    const result = await client.replay({ evaluationId: EVAL_ID });

    expect(result.rateLimit).not.toBeNull();
    expect(result.rateLimit?.limit).toBe(1000);
    expect(result.rateLimit?.remaining).toBe(998);
  });

  it("echoes evaluationId as decisionId when wire omits decision_id", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        // no decision_id field — server omitted it
        original_decision: "deny",
        engine_version: "wire-v1@1.4.0",
        engine_version_kind: "active",
        accepts_replay: true,
        variance: "NONE",
        envelope_verification: "absent",
        replayed_at: "2026-05-24T12:00:00.000Z",
      }),
    ) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);
    const result: ReplayResponse = await client.replay({
      evaluationId: EVAL_ID,
    });

    expect(result.decisionId).toBe(EVAL_ID);
  });
});
