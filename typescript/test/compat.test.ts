import { describe, it, expect, vi } from "vitest";
import { normalizeEvaluateRequest, normalizeEvaluateResponse } from "../src/compat.js";

describe("normalizeEvaluateRequest", () => {
  it("passes through v2 shape (action_type/actor_id) unchanged", () => {
    const input = { action_type: "files.read", actor_id: "agent-1", context: { env: "prod" } };
    const result = normalizeEvaluateRequest(input);
    expect(result).toBe(input);
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
