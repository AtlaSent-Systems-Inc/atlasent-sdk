import { describe, it, expect, vi } from "vitest";
import {
  normalizeEvaluateRequest,
  normalizeEvaluateResponse,
  resolveEvaluateIdentity,
} from "../src/compat.js";

describe("normalizeEvaluateRequest", () => {
  it("passes through v2 shape (action_type/actor_id) unchanged", () => {
    const input = { action_type: "files.read", actor_id: "agent-1", context: { env: "prod" } };
    const result = normalizeEvaluateRequest(input);
    expect(result).toBe(input);
  });

  it("does not emit a deprecation warning for the canonical shape", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    normalizeEvaluateRequest({ action_type: "files.read", actor_id: "agent-1" });
    const depWarn = warnSpy.mock.calls.find((args) => String(args[0]).includes("Deprecation"));
    expect(depWarn).toBeUndefined();
    warnSpy.mockRestore();
  });

  it("normalizes legacy shape (action/agent) to v2 with deprecation warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = normalizeEvaluateRequest({ action: "files.read", agent: "agent-1", context: { x: 1 } });
    expect(result.action_type).toBe("files.read");
    expect(result.actor_id).toBe("agent-1");
    expect(result.context).toEqual({ x: 1 });
    const depWarn = warnSpy.mock.calls.find((args) => String(args[0]).includes("Deprecation"));
    expect(depWarn).toBeDefined();
    warnSpy.mockRestore();
  });

  it("normalizes legacy shape without context", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = normalizeEvaluateRequest({ action: "data.write", agent: "bot" });
    expect(result.action_type).toBe("data.write");
    expect(result.context).toBeUndefined();
    warnSpy.mockRestore();
  });

  it("resolves a mixed shape (canonical actor_id + legacy action) per-field", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = normalizeEvaluateRequest({ actor_id: "agent-1", action: "files.read" });
    expect(result.action_type).toBe("files.read");
    expect(result.actor_id).toBe("agent-1");
    const depWarn = warnSpy.mock.calls.find((args) => String(args[0]).includes("Deprecation"));
    expect(depWarn).toBeDefined();
    warnSpy.mockRestore();
  });

  it("resolves a mixed shape (canonical action_type + legacy agent) per-field", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = normalizeEvaluateRequest({ action_type: "files.read", agent: "agent-1" });
    expect(result.action_type).toBe("files.read");
    expect(result.actor_id).toBe("agent-1");
    warnSpy.mockRestore();
  });

  it("prefers canonical fields over legacy aliases when both are present", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const input = {
      action_type: "files.read",
      actor_id: "canonical-actor",
      action: "legacy.action",
      agent: "legacy-agent",
    };
    const result = normalizeEvaluateRequest(input);
    // Pure-canonical resolution: both canonical fields present → pass-through.
    expect(result.action_type).toBe("files.read");
    expect(result.actor_id).toBe("canonical-actor");
    const depWarn = warnSpy.mock.calls.find((args) => String(args[0]).includes("Deprecation"));
    expect(depWarn).toBeUndefined();
    warnSpy.mockRestore();
  });

  it("carries evaluation_profile, override, and completion_proofs through the legacy-shape normalization branch", () => {
    // Regression coverage: these three fields are genuinely read server-side
    // (resolveProfile, the emergency-override gate, and the quorum check),
    // but the legacy-shape branch's field-by-field copy previously omitted
    // them — so a caller mixing a legacy alias (action/agent) with any of
    // these newer fields would have lost them silently during normalization,
    // even before client.ts's own (separately fixed) body construction.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = normalizeEvaluateRequest({
      action: "production.deploy",
      agent: "ci-bot",
      evaluation_profile: "advanced",
      override: {
        version: "override.v1",
        authority_actor_id: "ops-lead-1",
        reason: "P0 hotfix",
      },
      completion_proofs: [{ actor_id: "reviewer-1", action_type: "code_review.approve", permit_id: "pt.v2.tok" }],
    });
    expect(result.evaluation_profile).toBe("advanced");
    expect(result.override).toEqual({
      version: "override.v1",
      authority_actor_id: "ops-lead-1",
      reason: "P0 hotfix",
    });
    expect(result.completion_proofs).toEqual([
      { actor_id: "reviewer-1", action_type: "code_review.approve", permit_id: "pt.v2.tok" },
    ]);
    warnSpy.mockRestore();
  });
});

describe("resolveEvaluateIdentity", () => {
  it("resolves canonical fields without a deprecation warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const id = resolveEvaluateIdentity({ action_type: "files.read", actor_id: "agent-1" });
    expect(id).toEqual({ action_type: "files.read", actor_id: "agent-1" });
    expect(warnSpy.mock.calls.length).toBe(0);
    warnSpy.mockRestore();
  });

  it("resolves legacy aliases with a deprecation warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const id = resolveEvaluateIdentity({ action: "files.read", agent: "agent-1" });
    expect(id).toEqual({ action_type: "files.read", actor_id: "agent-1" });
    const depWarn = warnSpy.mock.calls.find((args) => String(args[0]).includes("Deprecation"));
    expect(depWarn).toBeDefined();
    warnSpy.mockRestore();
  });

  it("returns undefined for a missing identity component", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const id = resolveEvaluateIdentity({ action_type: "files.read" } as never);
    expect(id.action_type).toBe("files.read");
    expect(id.actor_id).toBeUndefined();
    warnSpy.mockRestore();
  });
});

describe("normalizeEvaluateResponse", () => {
  it("passes through v2 response (has decision field) unchanged", () => {
    const input = { decision: "allow" as const, permit_token: "tok_1" };
    const result = normalizeEvaluateResponse(input);
    expect(result).toBe(input);
  });

  it("normalizes legacy permitted=true to decision='allow'", () => {
    const result = normalizeEvaluateResponse({ permitted: true, decision_id: "dec_1" });
    expect(result.decision).toBe("allow");
    expect(result.permit_token).toBe("dec_1");
    expect(result.denial).toBeUndefined();
  });

  it("normalizes legacy permitted=false to decision='deny' with denial reason", () => {
    const result = normalizeEvaluateResponse({ permitted: false, decision_id: "dec_2", reason: "policy block" });
    expect(result.decision).toBe("deny");
    expect(result.denial?.reason).toBe("policy block");
  });

  it("normalizes legacy permitted=false without reason to just deny", () => {
    const result = normalizeEvaluateResponse({ permitted: false });
    expect(result.decision).toBe("deny");
    expect(result.denial).toBeUndefined();
  });

  it("normalizes legacy without decision_id (no permit_token)", () => {
    const result = normalizeEvaluateResponse({ permitted: true });
    expect(result.decision).toBe("allow");
    expect(result.permit_token).toBeUndefined();
  });
});
