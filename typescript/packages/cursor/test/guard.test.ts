import { describe, expect, it, vi } from "vitest";
import type { AtlaSentClient } from "@atlasent/sdk";
import { AtlaSentDeniedError } from "@atlasent/sdk";
import {
  DEFAULT_TOOL_ACTION,
  withCursorGuard,
  type CursorGuardedTool,
} from "../src/index.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

const ALLOW_EVAL = {
  decision: "allow" as const,
  permitId: "dec_alpha",
  reason: "authorized",
  auditHash: "hash_alpha",
  timestamp: "2026-04-29T10:00:00Z",
  rateLimit: null,
};

const DENY_EVAL = {
  decision: "deny" as const,
  permitId: "dec_beta",
  reason: "policy denied",
  auditHash: "hash_beta",
  timestamp: "2026-04-29T10:01:00Z",
  rateLimit: null,
};

const VERIFY_OK = {
  verified: true,
  outcome: "verified",
  permitHash: "permit_alpha",
  timestamp: "2026-04-29T10:00:01Z",
  rateLimit: null,
};

const VERIFY_REVOKED = {
  verified: false,
  outcome: "revoked",
  permitHash: "permit_alpha",
  timestamp: "2026-04-29T10:00:01Z",
  rateLimit: null,
};

// Overrides are test doubles with partial response fixtures, so they are typed
// loosely; the full client is cast below as before.
function makeClient(
  overrides: Partial<Record<keyof AtlaSentClient, unknown>> = {},
): AtlaSentClient {
  return {
    evaluate: vi.fn(async () => ALLOW_EVAL),
    verifyPermit: vi.fn(async () => VERIFY_OK),
    keySelf: vi.fn(),
    listAuditEvents: vi.fn(),
    createAuditExport: vi.fn(),
    ...overrides,
  } as unknown as AtlaSentClient;
}

const editTool: CursorGuardedTool = {
  name: "edit_file",
  description: "Apply a patch to a workspace file",
  parameters: {
    type: "object",
    properties: { path: { type: "string" }, patch: { type: "string" } },
    required: ["path", "patch"],
  },
  execute: async (input) => `patched ${(input as { path: string }).path}`,
};

const jsonTool: CursorGuardedTool = {
  name: "read_json",
  description: "Read a JSON file and return its contents",
  execute: async () => JSON.stringify({ value: 42 }),
};

// ── withCursorGuard ───────────────────────────────────────────────────────────

describe("withCursorGuard", () => {

  // ── default action: agent.tool.invoke (Canon ACT-0029) ───────────────────

  it("exports DEFAULT_TOOL_ACTION as agent.tool.invoke", () => {
    expect(DEFAULT_TOOL_ACTION).toBe("agent.tool.invoke");
  });

  it("defaults the action to agent.tool.invoke, never the bare tool name", async () => {
    const client = makeClient();
    const [guarded] = withCursorGuard([editTool], client, { agent: "bot" });
    await guarded!.execute({ path: "f.ts", patch: "x" });
    const evalArg = (client.evaluate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect(evalArg["action"]).toBe("agent.tool.invoke");
    expect(evalArg["action"]).not.toBe("edit_file");
    // verify is presented with the same action the permit was minted for
    expect(client.verifyPermit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "agent.tool.invoke" }),
    );
  });

  it("sets context.tool to the invoked tool's name", async () => {
    const client = makeClient();
    const [guarded] = withCursorGuard([editTool], client, { agent: "bot" });
    await guarded!.execute({ path: "f.ts", patch: "x" });
    const evalArg = (client.evaluate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { context: Record<string, unknown> };
    expect(evalArg.context["tool"]).toBe("edit_file");
    expect(evalArg.context["tool_input"]).toEqual({ path: "f.ts", patch: "x" });
  });

  it("does not let extraContext override context.tool", async () => {
    const client = makeClient();
    const [guarded] = withCursorGuard([editTool], client, {
      agent: "bot",
      extraContext: { tool: "some_harmless_tool", environment: "production" },
    });
    await guarded!.execute({ path: "f.ts", patch: "x" });
    const evalArg = (client.evaluate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { context: Record<string, unknown> };
    expect(evalArg.context["tool"]).toBe("edit_file");
    // other extraContext fields still pass through untouched
    expect(evalArg.context["environment"]).toBe("production");
  });

  it("does not let an extraContext resolver override context.tool", async () => {
    const client = makeClient();
    const [guarded] = withCursorGuard([editTool], client, {
      agent: "bot",
      extraContext: () => ({ tool: "spoofed" }),
    });
    await guarded!.execute({ path: "f.ts", patch: "x" });
    const evalArg = (client.evaluate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { context: Record<string, unknown> };
    expect(evalArg.context["tool"]).toBe("edit_file");
  });

  it("uses an explicit string action exactly as before", async () => {
    const client = makeClient();
    const [guarded] = withCursorGuard([editTool], client, {
      agent: "bot",
      action: "database.query.execute",
    });
    await guarded!.execute({ path: "f.ts", patch: "x" });
    expect(client.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ action: "database.query.execute" }),
    );
    expect(client.verifyPermit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "database.query.execute" }),
    );
  });

  it("does not invent an environment when the caller supplies none", async () => {
    const client = makeClient();
    const [guarded] = withCursorGuard([editTool], client, { agent: "bot" });
    await guarded!.execute({ path: "f.ts", patch: "x" });
    const evalArg = (client.evaluate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { context: Record<string, unknown> };
    expect("environment" in evalArg.context).toBe(false);
    const verifyArg = (client.verifyPermit as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect("environment" in verifyArg).toBe(false);
  });

  it("executes tool and returns plain string result on ALLOW + verified", async () => {
    const client = makeClient();
    const [guarded] = withCursorGuard([editTool], client, { agent: "cursor:proj" });
    const result = await guarded!.execute({ path: "src/main.ts", patch: "+" });
    expect(result).toBe("patched src/main.ts");
  });

  it("annotates JSON object string results with permit metadata", async () => {
    const client = makeClient();
    const [guarded] = withCursorGuard([jsonTool], client, { agent: "cursor:proj" });
    const raw = await guarded!.execute({});
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed["value"]).toBe(42);
    expect(parsed["_atlasent_permit_id"]).toBe("dec_alpha");
    expect(parsed["_atlasent_audit_hash"]).toBe("hash_alpha");
  });

  it("calls evaluate with agent.tool.invoke and context.tool by default", async () => {
    const client = makeClient();
    const [guarded] = withCursorGuard([editTool], client, { agent: "cursor:bot" });
    await guarded!.execute({ path: "f.ts", patch: "x" });
    expect(client.evaluate).toHaveBeenCalledWith({
      agent: "cursor:bot",
      action: "agent.tool.invoke",
      context: { tool: "edit_file", tool_input: { path: "f.ts", patch: "x" } },
    });
  });

  it("uses custom action resolver", async () => {
    const client = makeClient();
    const [guarded] = withCursorGuard([editTool], client, {
      agent: "cursor:bot",
      action: (name) => `cursor:${name}`,
    });
    await guarded!.execute({ path: "f.ts", patch: "x" });
    expect(client.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cursor:edit_file" }),
    );
  });

  it("throws AtlaSentDeniedError on DENY by default", async () => {
    const client = makeClient({ evaluate: vi.fn(async () => DENY_EVAL) });
    const [guarded] = withCursorGuard([editTool], client, { agent: "cursor:proj" });
    await expect(
      guarded!.execute({ path: "secrets.env", patch: "leak" }),
    ).rejects.toBeInstanceOf(AtlaSentDeniedError);
    expect(client.verifyPermit).not.toHaveBeenCalled();
  });

  it("returns JSON DenialResult string on DENY when onDeny='tool-result'", async () => {
    const client = makeClient({ evaluate: vi.fn(async () => DENY_EVAL) });
    const [guarded] = withCursorGuard([editTool], client, {
      agent: "cursor:proj",
      onDeny: "tool-result",
    });
    const raw = await guarded!.execute({ path: "f.ts", patch: "x" });
    const result = JSON.parse(raw) as { denied: boolean };
    expect(result.denied).toBe(true);
  });

  it("throws on verify failure by default", async () => {
    const client = makeClient({ verifyPermit: vi.fn(async () => VERIFY_REVOKED) });
    const [guarded] = withCursorGuard([editTool], client, { agent: "cursor:proj" });
    await expect(guarded!.execute({ path: "f.ts", patch: "x" })).rejects.toBeInstanceOf(
      AtlaSentDeniedError,
    );
  });

  it("returns JSON DenialResult on verify failure when onDeny='tool-result'", async () => {
    const client = makeClient({ verifyPermit: vi.fn(async () => VERIFY_REVOKED) });
    const [guarded] = withCursorGuard([editTool], client, {
      agent: "cursor:proj",
      onDeny: "tool-result",
    });
    const raw = await guarded!.execute({ path: "f.ts", patch: "x" });
    const result = JSON.parse(raw) as { denied: boolean; decision: string };
    expect(result.denied).toBe(true);
    expect(result.decision).toBe("verify_failed");
  });

  it("preserves name, description, and parameters", () => {
    const client = makeClient();
    const [guarded] = withCursorGuard([editTool], client, { agent: "cursor:proj" });
    expect(guarded!.name).toBe("edit_file");
    expect(guarded!.description).toBe("Apply a patch to a workspace file");
    expect(guarded!.parameters).toEqual(editTool.parameters);
  });

  it("returns plain text result unchanged (no annotation)", async () => {
    const plainTool: CursorGuardedTool = {
      name: "say",
      description: "Return a plain string",
      execute: async () => "hello world",
    };
    const client = makeClient();
    const [guarded] = withCursorGuard([plainTool], client, { agent: "cursor:proj" });
    expect(await guarded!.execute({})).toBe("hello world");
  });

  it("surfaces transport errors as JSON DenialResult when onDeny='tool-result'", async () => {
    const client = makeClient({
      evaluate: vi.fn(async () => { throw new Error("timeout"); }),
    });
    const [guarded] = withCursorGuard([editTool], client, {
      agent: "cursor:proj",
      onDeny: "tool-result",
    });
    const raw = await guarded!.execute({ path: "f.ts", patch: "x" });
    const result = JSON.parse(raw) as { denied: boolean; reason: string };
    expect(result.denied).toBe(true);
    expect(result.reason).toContain("timeout");
  });

  it("forwards extraContext to evaluate", async () => {
    const client = makeClient();
    const [guarded] = withCursorGuard([editTool], client, {
      agent: "cursor:proj",
      extraContext: { workspace: "my-repo" },
    });
    await guarded!.execute({ path: "f.ts", patch: "x" });
    expect(client.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        context: { workspace: "my-repo", tool: "edit_file", tool_input: { path: "f.ts", patch: "x" } },
      }),
    );
  });

  it("forwards stateSnapshot to evaluate as state_snapshot", async () => {
    const client = makeClient();
    const [guarded] = withCursorGuard([editTool], client, {
      agent: "cursor:proj",
      stateSnapshot: { source: "cursor", complete: true },
    });
    await guarded!.execute({ path: "f.ts", patch: "x" });
    expect(client.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        state_snapshot: { source: "cursor", complete: true },
      }),
    );
  });

  it("resolves a stateSnapshot function with tool name and input", async () => {
    const client = makeClient();
    const resolver = vi.fn(() => ({ source: "cursor", complete: true }));
    const [guarded] = withCursorGuard([editTool], client, {
      agent: "cursor:proj",
      stateSnapshot: resolver,
    });
    await guarded!.execute({ path: "f.ts", patch: "x" });
    expect(resolver).toHaveBeenCalledWith("edit_file", { path: "f.ts", patch: "x" });
  });

  it("omits state_snapshot from evaluate when stateSnapshot is not set", async () => {
    const client = makeClient();
    const [guarded] = withCursorGuard([editTool], client, { agent: "cursor:proj" });
    await guarded!.execute({ path: "f.ts", patch: "x" });
    expect(client.evaluate).toHaveBeenCalledWith({
      agent: "cursor:proj",
      action: "agent.tool.invoke",
      context: { tool: "edit_file", tool_input: { path: "f.ts", patch: "x" } },
    });
  });

  it("wraps all tools in the array", async () => {
    const client = makeClient();
    const [g1, g2] = withCursorGuard([editTool, jsonTool], client, { agent: "cursor:proj" });
    expect(g1!.name).toBe("edit_file");
    expect(g2!.name).toBe("read_json");
    await g1!.execute({ path: "f.ts", patch: "x" });
    await g2!.execute({});
    expect(client.evaluate).toHaveBeenCalledTimes(2);
  });
});
