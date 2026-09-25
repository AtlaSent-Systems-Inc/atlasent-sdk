import { describe, expect, it, vi } from "vitest";
import type { AtlaSentClient } from "@atlasent/sdk";
import { AtlaSentDeniedError } from "@atlasent/sdk";
import {
  DEFAULT_TOOL_ACTION,
  withLangChainGuard,
  type LangChainGuardedTool,
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

const queryTool: LangChainGuardedTool = {
  name: "query_db",
  description: "Run a read-only query",
  schema: {
    type: "object",
    properties: { sql: { type: "string" } },
    required: ["sql"],
  },
  execute: async (input) =>
    JSON.stringify({ rows: [(input as { sql: string }).sql] }),
};

const echoTool: LangChainGuardedTool = {
  name: "echo",
  description: "Echo a value as plain text",
  execute: async (input) => String((input as { value: string }).value),
};

// ── withLangChainGuard ────────────────────────────────────────────────────────

describe("withLangChainGuard", () => {

  // ── default action: agent.tool.invoke (Canon ACT-0029) ───────────────────

  it("exports DEFAULT_TOOL_ACTION as agent.tool.invoke", () => {
    expect(DEFAULT_TOOL_ACTION).toBe("agent.tool.invoke");
  });

  it("defaults the action to agent.tool.invoke, never the bare tool name", async () => {
    const client = makeClient();
    const [guarded] = withLangChainGuard([queryTool], client, { agent: "bot" });
    await guarded!.execute({ sql: "SELECT 1" });
    const evalArg = (client.evaluate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect(evalArg["action"]).toBe("agent.tool.invoke");
    expect(evalArg["action"]).not.toBe("query_db");
    // verify is presented with the same action the permit was minted for
    expect(client.verifyPermit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "agent.tool.invoke" }),
    );
  });

  it("sets context.tool to the invoked tool's name", async () => {
    const client = makeClient();
    const [guarded] = withLangChainGuard([queryTool], client, { agent: "bot" });
    await guarded!.execute({ sql: "SELECT 1" });
    const evalArg = (client.evaluate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { context: Record<string, unknown> };
    expect(evalArg.context["tool"]).toBe("query_db");
    expect(evalArg.context["tool_input"]).toEqual({ sql: "SELECT 1" });
  });

  it("does not let extraContext override context.tool", async () => {
    const client = makeClient();
    const [guarded] = withLangChainGuard([queryTool], client, {
      agent: "bot",
      extraContext: { tool: "some_harmless_tool", environment: "production" },
    });
    await guarded!.execute({ sql: "SELECT 1" });
    const evalArg = (client.evaluate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { context: Record<string, unknown> };
    expect(evalArg.context["tool"]).toBe("query_db");
    // other extraContext fields still pass through untouched
    expect(evalArg.context["environment"]).toBe("production");
  });

  it("does not let an extraContext resolver override context.tool", async () => {
    const client = makeClient();
    const [guarded] = withLangChainGuard([queryTool], client, {
      agent: "bot",
      extraContext: () => ({ tool: "spoofed" }),
    });
    await guarded!.execute({ sql: "SELECT 1" });
    const evalArg = (client.evaluate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { context: Record<string, unknown> };
    expect(evalArg.context["tool"]).toBe("query_db");
  });

  it("uses an explicit string action exactly as before", async () => {
    const client = makeClient();
    const [guarded] = withLangChainGuard([queryTool], client, {
      agent: "bot",
      action: "database.query.execute",
    });
    await guarded!.execute({ sql: "SELECT 1" });
    expect(client.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ action: "database.query.execute" }),
    );
    expect(client.verifyPermit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "database.query.execute" }),
    );
  });

  it("does not invent an environment when the caller supplies none", async () => {
    const client = makeClient();
    const [guarded] = withLangChainGuard([queryTool], client, { agent: "bot" });
    await guarded!.execute({ sql: "SELECT 1" });
    const evalArg = (client.evaluate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { context: Record<string, unknown> };
    expect("environment" in evalArg.context).toBe(false);
    const verifyArg = (client.verifyPermit as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect("environment" in verifyArg).toBe(false);
  });

  it("executes tool and annotates JSON result on ALLOW + verified", async () => {
    const client = makeClient();
    const [guarded] = withLangChainGuard([queryTool], client, { agent: "bot" });
    const raw = await guarded!.execute({ sql: "SELECT 1" });
    const result = JSON.parse(raw) as Record<string, unknown>;
    expect(result["rows"]).toEqual(["SELECT 1"]);
    expect(result["_atlasent_permit_id"]).toBe("dec_alpha");
    expect(result["_atlasent_audit_hash"]).toBe("hash_alpha");
  });

  it("calls evaluate with agent.tool.invoke and context.tool by default", async () => {
    const client = makeClient();
    const [guarded] = withLangChainGuard([queryTool], client, { agent: "svc:app" });
    await guarded!.execute({ sql: "SELECT 1" });
    expect(client.evaluate).toHaveBeenCalledWith({
      agent: "svc:app",
      action: "agent.tool.invoke",
      context: { tool: "query_db", tool_input: { sql: "SELECT 1" } },
    });
  });

  it("uses custom action resolver", async () => {
    const client = makeClient();
    const [guarded] = withLangChainGuard([queryTool], client, {
      agent: "bot",
      action: (name) => `tool:${name}`,
    });
    await guarded!.execute({ sql: "SELECT 1" });
    expect(client.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ action: "tool:query_db" }),
    );
  });

  it("throws AtlaSentDeniedError on DENY by default", async () => {
    const client = makeClient({ evaluate: vi.fn(async () => DENY_EVAL) });
    const [guarded] = withLangChainGuard([queryTool], client, { agent: "bot" });
    await expect(guarded!.execute({ sql: "DROP TABLE users" })).rejects.toBeInstanceOf(
      AtlaSentDeniedError,
    );
    expect(client.verifyPermit).not.toHaveBeenCalled();
  });

  it("returns JSON DenialResult string on DENY when onDeny='tool-result'", async () => {
    const client = makeClient({ evaluate: vi.fn(async () => DENY_EVAL) });
    const [guarded] = withLangChainGuard([queryTool], client, {
      agent: "bot",
      onDeny: "tool-result",
    });
    const raw = await guarded!.execute({ sql: "DROP TABLE users" });
    const result = JSON.parse(raw) as { denied: boolean };
    expect(result.denied).toBe(true);
  });

  it("throws on verify failure by default", async () => {
    const client = makeClient({ verifyPermit: vi.fn(async () => VERIFY_REVOKED) });
    const [guarded] = withLangChainGuard([queryTool], client, { agent: "bot" });
    await expect(guarded!.execute({ sql: "SELECT 1" })).rejects.toBeInstanceOf(
      AtlaSentDeniedError,
    );
  });

  it("returns JSON DenialResult on verify failure when onDeny='tool-result'", async () => {
    const client = makeClient({ verifyPermit: vi.fn(async () => VERIFY_REVOKED) });
    const [guarded] = withLangChainGuard([queryTool], client, {
      agent: "bot",
      onDeny: "tool-result",
    });
    const raw = await guarded!.execute({ sql: "SELECT 1" });
    const result = JSON.parse(raw) as { denied: boolean; decision: string };
    expect(result.denied).toBe(true);
    expect(result.decision).toBe("verify_failed");
  });

  it("preserves name, description, and schema", () => {
    const client = makeClient();
    const [guarded] = withLangChainGuard([queryTool], client, { agent: "bot" });
    expect(guarded!.name).toBe("query_db");
    expect(guarded!.description).toBe("Run a read-only query");
    expect(guarded!.schema).toEqual(queryTool.schema);
  });

  it("returns plain string result unchanged when not JSON object", async () => {
    const client = makeClient();
    const [guarded] = withLangChainGuard([echoTool], client, { agent: "bot" });
    expect(await guarded!.execute({ value: "hello" })).toBe("hello");
  });

  it("returns JSON array result unchanged (no annotation)", async () => {
    const arrTool: LangChainGuardedTool = {
      name: "list",
      description: "List items",
      execute: async () => JSON.stringify(["a", "b"]),
    };
    const client = makeClient();
    const [guarded] = withLangChainGuard([arrTool], client, { agent: "bot" });
    expect(await guarded!.execute({})).toBe('["a","b"]');
  });

  it("surfaces transport errors as JSON DenialResult when onDeny='tool-result'", async () => {
    const client = makeClient({
      evaluate: vi.fn(async () => { throw new Error("network timeout"); }),
    });
    const [guarded] = withLangChainGuard([queryTool], client, {
      agent: "bot",
      onDeny: "tool-result",
    });
    const raw = await guarded!.execute({ sql: "SELECT 1" });
    const result = JSON.parse(raw) as { denied: boolean; reason: string };
    expect(result.denied).toBe(true);
    expect(result.reason).toContain("network timeout");
  });

  it("forwards extraContext to evaluate", async () => {
    const client = makeClient();
    const [guarded] = withLangChainGuard([queryTool], client, {
      agent: "bot",
      extraContext: { env: "prod" },
    });
    await guarded!.execute({ sql: "SELECT 1" });
    expect(client.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        context: { env: "prod", tool: "query_db", tool_input: { sql: "SELECT 1" } },
      }),
    );
  });

  it("wraps all tools in the array", async () => {
    const client = makeClient();
    const [g1, g2] = withLangChainGuard([queryTool, echoTool], client, { agent: "bot" });
    expect(g1!.name).toBe("query_db");
    expect(g2!.name).toBe("echo");
    await g1!.execute({ sql: "SELECT 1" });
    await g2!.execute({ value: "hi" });
    expect(client.evaluate).toHaveBeenCalledTimes(2);
  });
});
