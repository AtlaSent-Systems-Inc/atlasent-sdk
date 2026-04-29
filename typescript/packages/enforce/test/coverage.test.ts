/**
 * Coverage-gap tests for @atlasent/enforce.
 *
 * Covers implementation branches that SIM-01..SIM-10 leave untouched,
 * without duplicating scenario logic.
 */

import { describe, expect, it, vi } from "vitest";
import {
  Enforce,
  type EnforceCompatibleClient,
  type EvaluateResponse,
  type VerifiedPermit,
} from "../src/index.js";
import { classifyClientError } from "../src/errors.js";

const BINDINGS = { orgId: "org_test", actorId: "actor_test", actionType: "deploy" };

const GOOD_PERMIT: VerifiedPermit = {
  token: "pt_ok",
  orgId: "org_test",
  actorId: "actor_test",
  actionType: "deploy",
  expiresAt: "2099-01-01T00:00:00Z",
};

// ── classifyClientError ───────────────────────────────────────────────────────

describe("classifyClientError", () => {
  it("returns fallback when err is not an Error instance (lines 33-34)", () => {
    expect(classifyClientError("string thrown", "evaluate_unavailable")).toBe(
      "evaluate_unavailable",
    );
    expect(classifyClientError(null, "verify_unavailable")).toBe("verify_unavailable");
    expect(classifyClientError(42, "evaluate_unavailable")).toBe("evaluate_unavailable");
  });

  it("returns _client_error variant for 4xx httpStatus", () => {
    const err = Object.assign(new Error("bad"), { httpStatus: 400 });
    expect(classifyClientError(err, "evaluate_unavailable")).toBe("evaluate_client_error");
  });

  it("returns fallback for 5xx httpStatus", () => {
    const err = Object.assign(new Error("oops"), { httpStatus: 503 });
    expect(classifyClientError(err, "verify_unavailable")).toBe("verify_unavailable");
  });
});

// ── Non-allow decision paths ──────────────────────────────────────────────────

describe("Enforce.run — non-allow / missing permit paths", () => {
  it("surfaces explicit reasonCode from evaluate response (line 36 non-null branch)", async () => {
    const client: EnforceCompatibleClient = {
      async evaluate(): Promise<EvaluateResponse> {
        return { decision: "deny", reasonCode: "ip_not_allowed" };
      },
      async verifyPermit(): Promise<VerifiedPermit> {
        throw new Error("should not be called");
      },
    };
    const enforce = new Enforce({ client, bindings: BINDINGS, failClosed: true });
    const execute = vi.fn();
    const result = await enforce.run({ request: {}, execute });
    expect(result.decision).toBe("deny");
    expect((result as { reasonCode?: string }).reasonCode).toBe("ip_not_allowed");
    expect(execute).not.toHaveBeenCalled();
  });

  it("enters early-return block when decision is allow but permit is absent (line 33 branch B)", async () => {
    // decision === "allow" but server omitted the permit (degenerate server response).
    // Line 33: `decision !== "allow"` is false, `!permit` is true → enters the early-return block.
    const client: EnforceCompatibleClient = {
      async evaluate(): Promise<EvaluateResponse> {
        return { decision: "allow" }; // no permit field
      },
      async verifyPermit(): Promise<VerifiedPermit> {
        throw new Error("should not be called");
      },
    };
    const enforce = new Enforce({ client, bindings: BINDINGS, failClosed: true });
    const execute = vi.fn();
    const result = await enforce.run({ request: {}, execute });
    expect(result.decision).toBe("allow");
    expect(execute).not.toHaveBeenCalled();
  });
});

// ── evaluate() throws ─────────────────────────────────────────────────────────

describe("Enforce.run — evaluate throws", () => {
  it("returns deny with evaluate_unavailable when evaluate throws a plain Error (lines 27-31)", async () => {
    const client: EnforceCompatibleClient = {
      async evaluate(): Promise<EvaluateResponse> {
        throw new Error("network down");
      },
      async verifyPermit(): Promise<VerifiedPermit> {
        throw new Error("should not be called");
      },
    };
    const enforce = new Enforce({ client, bindings: BINDINGS, failClosed: true });
    const execute = vi.fn();
    const result = await enforce.run({ request: {}, execute });
    expect(result.decision).toBe("deny");
    expect((result as { reasonCode?: string }).reasonCode).toBe("evaluate_unavailable");
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns evaluate_client_error when evaluate throws with httpStatus 400", async () => {
    const client: EnforceCompatibleClient = {
      async evaluate(): Promise<EvaluateResponse> {
        throw Object.assign(new Error("bad request"), { httpStatus: 400 });
      },
      async verifyPermit(): Promise<VerifiedPermit> {
        throw new Error("should not be called");
      },
    };
    const enforce = new Enforce({ client, bindings: BINDINGS, failClosed: true });
    const result = await enforce.run({ request: {}, execute: vi.fn() });
    expect(result.decision).toBe("deny");
    expect((result as { reasonCode?: string }).reasonCode).toBe("evaluate_client_error");
  });
});

// ── Binding mismatch after successful verify ──────────────────────────────────

describe("Enforce.run — binding mismatch after successful verify", () => {
  it("denies with binding_mismatch when verified permit actor differs (lines 63-64)", async () => {
    const mismatchedPermit: VerifiedPermit = {
      ...GOOD_PERMIT,
      actorId: "different_actor",
    };
    const client: EnforceCompatibleClient = {
      async evaluate(): Promise<EvaluateResponse> {
        return { decision: "allow", permit: { token: "pt_ok", expiresAt: "2099-01-01T00:00:00Z" } };
      },
      async verifyPermit(): Promise<VerifiedPermit> {
        return mismatchedPermit;
      },
    };
    const enforce = new Enforce({ client, bindings: BINDINGS, failClosed: true });
    const execute = vi.fn();
    const result = await enforce.run({ request: {}, execute });
    expect(result.decision).toBe("deny");
    expect((result as { reasonCode?: string }).reasonCode).toBe("binding_mismatch");
    expect(execute).not.toHaveBeenCalled();
  });
});

// ── Verify completes within latency budget ────────────────────────────────────

describe("Enforce.run — verify completes within budget", () => {
  it("allows when verify resolves before latencyBudgetMs (lines 88-89)", async () => {
    const client: EnforceCompatibleClient = {
      async evaluate(): Promise<EvaluateResponse> {
        return { decision: "allow", permit: { token: "pt_ok", expiresAt: "2099-01-01T00:00:00Z" } };
      },
      async verifyPermit(): Promise<VerifiedPermit> {
        return GOOD_PERMIT; // resolves immediately, well within any budget
      },
    };
    const enforce = new Enforce({
      client,
      bindings: BINDINGS,
      failClosed: true,
      latencyBudgetMs: 5_000,
    });
    const execute = vi.fn(async () => "done");
    const result = await enforce.run({ request: {}, execute });
    expect(result.decision).toBe("allow");
    expect(execute).toHaveBeenCalledOnce();
  });
});

// ── Warn mode without onLatencyBreach callback ───────────────────────────────

describe("Enforce.run — warn mode without callback", () => {
  it("allows when verify is slow but latencyBreachMode=warn and no callback set", async () => {
    const client: EnforceCompatibleClient = {
      async evaluate(): Promise<EvaluateResponse> {
        return { decision: "allow", permit: { token: "pt_ok", expiresAt: "2099-01-01T00:00:00Z" } };
      },
      async verifyPermit(): Promise<VerifiedPermit> {
        await new Promise((r) => setTimeout(r, 300));
        return GOOD_PERMIT;
      },
    };
    const enforce = new Enforce({
      client,
      bindings: BINDINGS,
      failClosed: true,
      latencyBudgetMs: 50,
      latencyBreachMode: "warn",
      // onLatencyBreach intentionally omitted
    });
    const execute = vi.fn(async () => "done");
    const result = await enforce.run({ request: {}, execute });
    expect(result.decision).toBe("allow");
    expect(execute).toHaveBeenCalledOnce();
  });
});
