import { describe, expect, it, vi } from "vitest";
import type { AtlaSentClient } from "@atlasent/sdk";
import { AtlaSentDeniedError, AtlaSentError } from "@atlasent/sdk";
import {
  toolEvaluate,
  toolProtect,
  toolVerifyPermit,
  toolKeySelf,
  formatError,
} from "../src/tools.js";

// ── shared fixtures ──────────────────────────────────────────────────────────

const ALLOW_RESP = {
  decision: "ALLOW" as const,
  permitted: true,
  permitId: "dec_alpha",
  reason: "GxP policy authorized",
  auditHash: "hash_alpha",
  timestamp: "2026-04-29T10:00:00Z",
  rateLimit: null,
};

const DENY_RESP = {
  decision: "DENY" as const,
  permitted: false,
  permitId: "dec_beta",
  reason: "Missing change_reason",
  auditHash: "hash_beta",
  timestamp: "2026-04-29T10:01:00Z",
  rateLimit: null,
};

const VERIFY_OK_RESP = {
  verified: true,
  outcome: "verified",
  permitHash: "permit_alpha",
  timestamp: "2026-04-29T10:00:01Z",
  rateLimit: null,
};

const VERIFY_REVOKED_RESP = {
  verified: false,
  outcome: "revoked",
  permitHash: "permit_alpha",
  timestamp: "2026-04-29T10:00:01Z",
  rateLimit: null,
};

const KEY_SELF_RESP = {
  keyId: "key_abc123",
  environment: "production",
};

function makeClient(overrides: Partial<AtlaSentClient> = {}): AtlaSentClient {
  return {
    evaluate: vi.fn(async () => ALLOW_RESP),
    verifyPermit: vi.fn(async () => VERIFY_OK_RESP),
    keySelf: vi.fn(async () => KEY_SELF_RESP),
    listAuditEvents: vi.fn(),
    createAuditExport: vi.fn(),
    ...overrides,
  } as unknown as AtlaSentClient;
}

// ── toolEvaluate ─────────────────────────────────────────────────────────────

describe("toolEvaluate", () => {
  it("returns ALLOW response", async () => {
    const client = makeClient();
    const result = await toolEvaluate(client, {
      agent: "bot",
      action: "deploy",
    });
    expect(result.decision).toBe("ALLOW");
    expect(result.permitId).toBe("dec_alpha");
    expect(client.evaluate).toHaveBeenCalledWith({
      agent: "bot",
      action: "deploy",
    });
  });

  it("passes context when provided", async () => {
    const client = makeClient();
    const ctx = { commit: "abc123" };
    await toolEvaluate(client, { agent: "bot", action: "deploy", context: ctx });
    expect(client.evaluate).toHaveBeenCalledWith({
      agent: "bot",
      action: "deploy",
      context: ctx,
    });
  });

  it("omits context key when not provided", async () => {
    const client = makeClient();
    await toolEvaluate(client, { agent: "a", action: "b" });
    const call = vi.mocked(client.evaluate).mock.calls[0]![0];
    expect("context" in call).toBe(false);
  });

  it("returns DENY as data — does not throw", async () => {
    const client = makeClient({
      evaluate: vi.fn(async () => DENY_RESP),
    });
    const result = await toolEvaluate(client, { agent: "a", action: "b" });
    expect(result.decision).toBe("DENY");
  });
});

// ── toolProtect ──────────────────────────────────────────────────────────────

describe("toolProtect", () => {
  it("returns Permit on ALLOW + verified", async () => {
    const client = makeClient();
    const permit = await toolProtect(client, { agent: "bot", action: "deploy" });
    expect(permit.permitId).toBe("dec_alpha");
    expect(permit.permitHash).toBe("permit_alpha");
    expect(permit.auditHash).toBe("hash_alpha");
    expect(client.evaluate).toHaveBeenCalledTimes(1);
    expect(client.verifyPermit).toHaveBeenCalledTimes(1);
  });

  it("forwards context to both evaluate and verifyPermit", async () => {
    const client = makeClient();
    const ctx = { approver: "alice" };
    await toolProtect(client, { agent: "bot", action: "deploy", context: ctx });
    expect(vi.mocked(client.evaluate).mock.calls[0]![0].context).toEqual(ctx);
    expect(vi.mocked(client.verifyPermit).mock.calls[0]![0].context).toEqual(ctx);
  });

  it("throws AtlaSentDeniedError on policy DENY — never calls verifyPermit", async () => {
    const client = makeClient({ evaluate: vi.fn(async () => DENY_RESP) });
    await expect(
      toolProtect(client, { agent: "a", action: "b" }),
    ).rejects.toBeInstanceOf(AtlaSentDeniedError);
    expect(client.verifyPermit).not.toHaveBeenCalled();
  });

  it("throws AtlaSentDeniedError when permit is revoked", async () => {
    const client = makeClient({
      verifyPermit: vi.fn(async () => VERIFY_REVOKED_RESP),
    });
    await expect(
      toolProtect(client, { agent: "a", action: "b" }),
    ).rejects.toBeInstanceOf(AtlaSentDeniedError);
  });

  it("forwards permit_id from evaluate to verifyPermit", async () => {
    const client = makeClient();
    await toolProtect(client, { agent: "bot", action: "deploy" });
    expect(vi.mocked(client.verifyPermit).mock.calls[0]![0].permitId).toBe(
      "dec_alpha",
    );
  });
});

// ── toolVerifyPermit ─────────────────────────────────────────────────────────

describe("toolVerifyPermit", () => {
  it("returns VerifyPermitResponse", async () => {
    const client = makeClient();
    const result = await toolVerifyPermit(client, { permitId: "dec_alpha" });
    expect(result.verified).toBe(true);
    expect(result.outcome).toBe("verified");
    expect(client.verifyPermit).toHaveBeenCalledWith({ permitId: "dec_alpha" });
  });

  it("passes optional fields when provided", async () => {
    const client = makeClient();
    await toolVerifyPermit(client, {
      permitId: "dec_alpha",
      agent: "bot",
      action: "deploy",
      context: { k: "v" },
    });
    expect(client.verifyPermit).toHaveBeenCalledWith({
      permitId: "dec_alpha",
      agent: "bot",
      action: "deploy",
      context: { k: "v" },
    });
  });
});

// ── toolKeySelf ──────────────────────────────────────────────────────────────

describe("toolKeySelf", () => {
  it("returns ApiKeySelfResponse", async () => {
    const client = makeClient();
    const result = await toolKeySelf(client);
    expect(result.keyId).toBe("key_abc123");
    expect(result.environment).toBe("production");
  });
});

// ── formatError ──────────────────────────────────────────────────────────────

describe("formatError", () => {
  it("formats AtlaSentDeniedError", () => {
    const err = new AtlaSentDeniedError({
      decision: "deny",
      evaluationId: "dec_x",
      reason: "policy says no",
    });
    const msg = formatError(err);
    expect(msg).toContain("DENIED");
    expect(msg).toContain("dec_x");
    expect(msg).toContain("policy says no");
  });

  it("formats AtlaSentError", () => {
    const err = new AtlaSentError("slow down", { code: "rate_limited" });
    expect(formatError(err)).toContain("rate_limited");
    expect(formatError(err)).toContain("slow down");
  });

  it("formats plain Error", () => {
    expect(formatError(new Error("boom"))).toBe("boom");
  });

  it("formats unknown values", () => {
    expect(formatError("oops")).toBe("oops");
  });
});
