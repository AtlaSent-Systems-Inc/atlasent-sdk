// Tests for D4 — `AtlaSentDeniedError.outcome` discriminator.
//
// Mirrors the Python SDK's tests/test_deny_outcome.py (atlasent-sdk PR
// #132) so the cross-language matrix described in
// `atlasent/docs/REVOCATION_RUNBOOK.md` is executable from either side.

import { afterEach, beforeEach, describe, expect, it, vi, type MockedFunction } from "vitest";

import {
  AtlaSentDeniedError,
  configure,
  normalizePermitOutcome,
  protect,
  type PermitOutcome,
} from "../src/index.js";
import { __resetSharedClientForTests } from "../src/protect.js";

type FetchMock = MockedFunction<typeof fetch>;

const EVALUATE_ALLOW_WIRE = {
  permitted: true,
  decision_id: "dec_alpha",
  reason: "policy authorized",
  audit_hash: "hash_alpha",
  timestamp: "2026-04-30T06:00:00Z",
};

function verifyWire(outcome: string): Record<string, unknown> {
  return {
    verified: false,
    outcome,
    permit_hash: "ph_alpha",
    timestamp: "2026-04-30T06:00:01Z",
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetchSequence(responses: Response[]): FetchMock {
  const queue = [...responses];
  return vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("mock fetch queue exhausted");
    return next;
  }) as unknown as FetchMock;
}

// ─── Outcome normalization ────────────────────────────────────────────

describe("normalizePermitOutcome", () => {
  it.each<PermitOutcome>([
    "permit_consumed",
    "permit_expired",
    "permit_revoked",
    "permit_not_found",
  ])("passes through known outcome %s", (raw) => {
    expect(normalizePermitOutcome(raw)).toBe(raw);
  });

  it.each([undefined, "", "verified", "permit_quantum_entangled"])(
    "maps %p to undefined",
    (raw) => {
      expect(normalizePermitOutcome(raw as string | undefined)).toBeUndefined();
    },
  );
});

// ─── Predicate sugar ──────────────────────────────────────────────────

describe("AtlaSentDeniedError predicates", () => {
  it("default outcome is undefined; no predicate fires", () => {
    const err = new AtlaSentDeniedError({
      decision: "deny",
      evaluationId: "dec_x",
      reason: "r",
    });
    expect(err.outcome).toBeUndefined();
    expect(err.isRevoked).toBe(false);
    expect(err.isExpired).toBe(false);
    expect(err.isConsumed).toBe(false);
    expect(err.isNotFound).toBe(false);
  });

  it.each<{ outcome: PermitOutcome; predicate: keyof AtlaSentDeniedError }>([
    { outcome: "permit_revoked", predicate: "isRevoked" },
    { outcome: "permit_expired", predicate: "isExpired" },
    { outcome: "permit_consumed", predicate: "isConsumed" },
    { outcome: "permit_not_found", predicate: "isNotFound" },
  ])("each outcome lights exactly one predicate ($outcome → $predicate)", ({
    outcome,
    predicate,
  }) => {
    const err = new AtlaSentDeniedError({
      decision: "deny",
      evaluationId: "dec_x",
      outcome,
    });
    expect(err.outcome).toBe(outcome);
    const predicates: ReadonlyArray<keyof AtlaSentDeniedError> = [
      "isRevoked",
      "isExpired",
      "isConsumed",
      "isNotFound",
    ];
    for (const p of predicates) {
      expect(err[p]).toBe(p === predicate);
    }
  });
});

// ─── End-to-end propagation through protect() ────────────────────────

describe("protect() propagates outcome from /v1-verify-permit", () => {
  beforeEach(() => __resetSharedClientForTests());
  afterEach(() => __resetSharedClientForTests());

  it.each<{
    wireOutcome: string;
    expectedOutcome: PermitOutcome;
    expectedPredicate: keyof AtlaSentDeniedError;
  }>([
    {
      wireOutcome: "permit_consumed",
      expectedOutcome: "permit_consumed",
      expectedPredicate: "isConsumed",
    },
    {
      wireOutcome: "permit_expired",
      expectedOutcome: "permit_expired",
      expectedPredicate: "isExpired",
    },
    {
      wireOutcome: "permit_revoked",
      expectedOutcome: "permit_revoked",
      expectedPredicate: "isRevoked",
    },
    {
      wireOutcome: "permit_not_found",
      expectedOutcome: "permit_not_found",
      expectedPredicate: "isNotFound",
    },
  ])(
    "$wireOutcome → outcome=$expectedOutcome",
    async ({ wireOutcome, expectedOutcome, expectedPredicate }) => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(EVALUATE_ALLOW_WIRE),
        jsonResponse(verifyWire(wireOutcome)),
      ]);
      configure({ apiKey: "ask_live_test", fetch: fetchImpl });

      try {
        await protect({ agent: "a", action: "b" });
        throw new Error("expected protect() to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(AtlaSentDeniedError);
        const denied = err as AtlaSentDeniedError;
        expect(denied.outcome).toBe(expectedOutcome);
        expect(denied[expectedPredicate]).toBe(true);
      }
    },
  );

  it("unknown wire outcome normalizes to undefined", async () => {
    const fetchImpl = mockFetchSequence([
      jsonResponse(EVALUATE_ALLOW_WIRE),
      jsonResponse(verifyWire("permit_quantum_entangled")),
    ]);
    configure({ apiKey: "ask_live_test", fetch: fetchImpl });

    try {
      await protect({ agent: "a", action: "b" });
      throw new Error("expected protect() to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AtlaSentDeniedError);
      const denied = err as AtlaSentDeniedError;
      // The reason still carries the raw outcome string for
      // debuggability; the discriminator is undefined so callers
      // branching on `outcome` won't accidentally match an unknown
      // literal.
      expect(denied.outcome).toBeUndefined();
      expect(denied.reason).toContain("permit_quantum_entangled");
    }
  });
});
