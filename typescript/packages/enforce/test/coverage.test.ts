/**
 * Targeted coverage tests for branches the SIM scenarios don't reach.
 *
 * The 10 SIM scenarios exercise the policy-decision lattice end-to-end
 * but not the error-classifier fallbacks or the latency-budget happy
 * path, leaving lines uncovered relative to the package's 100% floor.
 * Each test below names the file:line range it closes.
 */

import { describe, expect, it } from "vitest";
import {
  Enforce,
  type EnforceCompatibleClient,
  type EvaluateResponse,
  type VerifiedPermit,
} from "../src/index.js";

const BINDINGS = { orgId: "org_test", actorId: "actor_test", actionType: "deploy" };

const VERIFIED_PERMIT: VerifiedPermit = {
  token: "pt_valid",
  orgId: "org_test",
  actorId: "actor_test",
  actionType: "deploy",
  expiresAt: "2099-01-01T00:00:00Z",
};

const ALLOW_PERMIT: EvaluateResponse = {
  decision: "allow",
  permit: { token: "pt_valid", expiresAt: "2099-01-01T00:00:00Z" },
};

function clientFrom(
  overrides: Partial<EnforceCompatibleClient> = {},
): EnforceCompatibleClient {
  return {
    async evaluate(): Promise<EvaluateResponse> {
      return ALLOW_PERMIT;
    },
    async verifyPermit(): Promise<VerifiedPermit> {
      return VERIFIED_PERMIT;
    },
    ...overrides,
  };
}

// ── enforce.ts:27-31 — evaluate() throws; reason classified ────────────

describe("evaluate() throws", () => {
  it("returns deny with classifyClientError fallback when client throws plain Error", async () => {
    const enforce = new Enforce({
      client: clientFrom({
        async evaluate() {
          throw new Error("connection refused");
        },
      }),
      bindings: BINDINGS,
      failClosed: true,
    });
    const result = await enforce.run({
      request: {},
      execute: async () => "should-not-run",
    });
    expect(result.decision).toBe("deny");
    if (result.decision !== "allow") {
      expect(result.reasonCode).toBe("evaluate_unavailable");
    }
  });

  it("propagates a custom reasonCode from the thrown error", async () => {
    const enforce = new Enforce({
      client: clientFrom({
        async evaluate() {
          const err = new Error("rate limited") as Error & { reasonCode: string };
          err.reasonCode = "rate_limited";
          throw err;
        },
      }),
      bindings: BINDINGS,
      failClosed: true,
    });
    const result = await enforce.run({
      request: {},
      execute: async () => "x",
    });
    expect(result.decision).toBe("deny");
    if (result.decision !== "allow") {
      expect(result.reasonCode).toBe("rate_limited");
    }
  });

  it("maps 4xx httpStatus to evaluate_client_error", async () => {
    const enforce = new Enforce({
      client: clientFrom({
        async evaluate() {
          const err = new Error("forbidden") as Error & { httpStatus: number };
          err.httpStatus = 403;
          throw err;
        },
      }),
      bindings: BINDINGS,
      failClosed: true,
    });
    const result = await enforce.run({ request: {}, execute: async () => "x" });
    expect(result.decision).toBe("deny");
    if (result.decision !== "allow") {
      expect(result.reasonCode).toBe("evaluate_client_error");
    }
  });
});

// ── errors.ts:33-34 — fallback return when err lacks all hints ─────────

describe("classifyClientError fallback", () => {
  it("returns fallback when error is not an Error instance", async () => {
    const enforce = new Enforce({
      client: clientFrom({
        async evaluate(): Promise<EvaluateResponse> {
          // throw a non-Error value — exits the `instanceof Error` branch
          throw "plain string";
        },
      }),
      bindings: BINDINGS,
      failClosed: true,
    });
    const result = await enforce.run({ request: {}, execute: async () => "x" });
    expect(result.decision).toBe("deny");
    if (result.decision !== "allow") {
      expect(result.reasonCode).toBe("evaluate_unavailable");
    }
  });

  it("returns fallback when Error has no reasonCode or httpStatus", async () => {
    // verifyPermit-side path so we hit classifyClientError with verify_unavailable
    const enforce = new Enforce({
      client: clientFrom({
        async verifyPermit(): Promise<VerifiedPermit> {
          throw new Error("opaque failure");
        },
      }),
      bindings: BINDINGS,
      failClosed: true,
    });
    const result = await enforce.run({ request: {}, execute: async () => "x" });
    expect(result.decision).toBe("deny");
    if (result.decision !== "allow") {
      expect(result.reasonCode).toBe("verify_unavailable");
    }
  });
});

// ── enforce.ts:36 — reasonCode ?? decision fallback ────────────────────
// SIM scenarios always include a reasonCode on non-allow decisions, so
// the right-hand side of the nullish-coalesce never fires there.

describe("evaluate non-allow without reasonCode", () => {
  it("falls back to decision when reasonCode is absent", async () => {
    const enforce = new Enforce({
      client: clientFrom({
        async evaluate(): Promise<EvaluateResponse> {
          return { decision: "deny" }; // no reasonCode, no permit
        },
      }),
      bindings: BINDINGS,
      failClosed: true,
    });
    const result = await enforce.run({ request: {}, execute: async () => "x" });
    expect(result.decision).toBe("deny");
    if (result.decision !== "allow") {
      expect(result.reasonCode).toBe("deny");
    }
  });
});

// ── enforce.ts:63-64 — binding mismatch return ─────────────────────────
// (SIM-03 covers actor mismatch; this exercises org and actionType mismatches
//  to land the full branch combination.)

describe("binding mismatch", () => {
  it("denies when verifiedPermit.orgId differs from bindings.orgId", async () => {
    const enforce = new Enforce({
      client: clientFrom({
        async verifyPermit() {
          return { ...VERIFIED_PERMIT, orgId: "org_other" };
        },
      }),
      bindings: BINDINGS,
      failClosed: true,
    });
    const result = await enforce.run({ request: {}, execute: async () => "x" });
    expect(result.decision).toBe("deny");
    if (result.decision !== "allow") {
      expect(result.reasonCode).toBe("binding_mismatch");
    }
  });

  it("denies when verifiedPermit.actionType differs from bindings.actionType", async () => {
    const enforce = new Enforce({
      client: clientFrom({
        async verifyPermit() {
          return { ...VERIFIED_PERMIT, actionType: "drop_table" };
        },
      }),
      bindings: BINDINGS,
      failClosed: true,
    });
    const result = await enforce.run({ request: {}, execute: async () => "x" });
    expect(result.decision).toBe("deny");
    if (result.decision !== "allow") {
      expect(result.reasonCode).toBe("binding_mismatch");
    }
  });
});

// ── enforce.ts:87-89 — verifyWithBudget happy path with budget set ─────
// SIM-06 covers the breach paths (deny + warn). This covers the case
// where verify resolves *before* the budget timer fires, which the
// SIM-06 mocks specifically don't exercise.

describe("verifyWithBudget — verify wins the race", () => {
  it("returns the permit when verify completes before latencyBudgetMs", async () => {
    const enforce = new Enforce({
      client: clientFrom({
        async verifyPermit() {
          return VERIFIED_PERMIT;
        },
      }),
      bindings: BINDINGS,
      failClosed: true,
      latencyBudgetMs: 1000, // generous
      latencyBreachMode: "deny",
    });
    const ran: string[] = [];
    const result = await enforce.run({
      request: {},
      execute: async (permit) => {
        ran.push(permit.token);
        return permit.token;
      },
    });
    expect(result.decision).toBe("allow");
    expect(ran).toEqual([VERIFIED_PERMIT.token]);
  });
});
