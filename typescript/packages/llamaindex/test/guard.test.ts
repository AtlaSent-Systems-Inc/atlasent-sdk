import { describe, expect, it, vi } from "vitest";
import type { AtlaSentClient } from "@atlasent/sdk";
import { AtlaSentDeniedError } from "@atlasent/sdk";
import {
  DEFAULT_TOOL_ACTION,
  withLlamaIndexGuard,
  type LlamaIndexGuardedTool,
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

const searchTool: LlamaIndexGuardedTool = {
  metadata: {
    name: "vector_search",
    description: "Semantic search over the knowledge base",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  execute: async (input) => ({
    results: [(input as { query: string }).query],
  }),
};

const countTool: LlamaIndexGuardedTool = {
  metadata: { name: "count", description: "Return a number" },
  execute: async () => 42,
};

// ── withLlamaIndexGuard ───────────────────────────────────────────────────────

describe("withLlamaIndexGuard", () => {

  // ── default action: agent.tool.invoke (Canon ACT-0029) ───────────────────

  it("exports DEFAULT_TOOL_ACTION as agent.tool.invoke", () => {
    expect(DEFAULT_TOOL_ACTION).toBe("agent.tool.invoke");
  });

  it("defaults the action to agent.tool.invoke, never the bare tool name", async () => {
    const client = makeClient();
    const [guarded] = withLlamaIndexGuard([searchTool], client, { agent: "bot" });
    await guarded!.execute({ query: "x" });
    const evalArg = (client.evaluate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect(evalArg["action"]).toBe("agent.tool.invoke");
    expect(evalArg["action"]).not.toBe("vector_search");
    // verify is presented with the same action the permit was minted for
    expect(client.verifyPermit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "agent.tool.invoke" }),
    );
  });

  it("sets context.tool to the invoked tool's name", async () => {
    const client = makeClient();
    const [guarded] = withLlamaIndexGuard([searchTool], client, { agent: "bot" });
    await guarded!.execute({ query: "x" });
    const evalArg = (client.evaluate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { context: Record<string, unknown> };
    expect(evalArg.context["tool"]).toBe("vector_search");
    expect(evalArg.context["tool_input"]).toEqual({ query: "x" });
  });

  it("does not let extraContext override context.tool", async () => {
    const client = makeClient();
    const [guarded] = withLlamaIndexGuard([searchTool], client, {
      agent: "bot",
      extraContext: { tool: "some_harmless_tool", environment: "production" },
    });
    await guarded!.execute({ query: "x" });
    const evalArg = (client.evaluate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { context: Record<string, unknown> };
    expect(evalArg.context["tool"]).toBe("vector_search");
    // other extraContext fields still pass through untouched
    expect(evalArg.context["environment"]).toBe("production");
  });

  it("does not let an extraContext resolver override context.tool", async () => {
    const client = makeClient();
    const [guarded] = withLlamaIndexGuard([searchTool], client, {
      agent: "bot",
      extraContext: () => ({ tool: "spoofed" }),
    });
    await guarded!.execute({ query: "x" });
    const evalArg = (client.evaluate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { context: Record<string, unknown> };
    expect(evalArg.context["tool"]).toBe("vector_search");
  });

  it("uses an explicit string action exactly as before", async () => {
    const client = makeClient();
    const [guarded] = withLlamaIndexGuard([searchTool], client, {
      agent: "bot",
      action: "database.query.execute",
    });
    await guarded!.execute({ query: "x" });
    expect(client.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ action: "database.query.execute" }),
    );
    expect(client.verifyPermit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "database.query.execute" }),
    );
  });

  it("does not invent an environment when the caller supplies none", async () => {
    const client = makeClient();
    const [guarded] = withLlamaIndexGuard([searchTool], client, { agent: "bot" });
    await guarded!.execute({ query: "x" });
    const evalArg = (client.evaluate as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { context: Record<string, unknown> };
    expect("environment" in evalArg.context).toBe(false);
    const verifyArg = (client.verifyPermit as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect("environment" in verifyArg).toBe(false);
  });

  it("executes tool and annotates object result on ALLOW + verified", async () => {
    const client = makeClient();
    const [guarded] = withLlamaIndexGuard([searchTool], client, { agent: "bot" });
    const result = (await guarded!.execute({ query: "hello" })) as Record<string, unknown>;
    expect((result["results"] as string[])[0]).toBe("hello");
    expect(result["_atlasent_permit_id"]).toBe("dec_alpha");
    expect(result["_atlasent_audit_hash"]).toBe("hash_alpha");
  });

  it("calls evaluate with agent.tool.invoke and context.tool by default", async () => {
    const client = makeClient();
    const [guarded] = withLlamaIndexGuard([searchTool], client, { agent: "svc:app" });
    await guarded!.execute({ query: "x" });
    expect(client.evaluate).toHaveBeenCalledWith({
      agent: "svc:app",
      action: "agent.tool.invoke",
      context: { tool: "vector_search", tool_input: { query: "x" } },
    });
  });

  it("uses custom action resolver", async () => {
    const client = makeClient();
    const [guarded] = withLlamaIndexGuard([searchTool], client, {
      agent: "bot",
      action: (name) => `tool:${name}`,
    });
    await guarded!.execute({ query: "x" });
    expect(client.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ action: "tool:vector_search" }),
    );
  });

  it("throws AtlaSentDeniedError on DENY by default", async () => {
    const client = makeClient({ evaluate: vi.fn(async () => DENY_EVAL) });
    const [guarded] = withLlamaIndexGuard([searchTool], client, { agent: "bot" });
    await expect(guarded!.execute({ query: "secret" })).rejects.toBeInstanceOf(
      AtlaSentDeniedError,
    );
    expect(client.verifyPermit).not.toHaveBeenCalled();
  });

  it("returns DenialResult on DENY when onDeny='tool-result'", async () => {
    const client = makeClient({ evaluate: vi.fn(async () => DENY_EVAL) });
    const [guarded] = withLlamaIndexGuard([searchTool], client, {
      agent: "bot",
      onDeny: "tool-result",
    });
    const result = (await guarded!.execute({ query: "secret" })) as { denied: boolean };
    expect(result.denied).toBe(true);
  });

  it("throws on verify failure by default", async () => {
    const client = makeClient({ verifyPermit: vi.fn(async () => VERIFY_REVOKED) });
    const [guarded] = withLlamaIndexGuard([searchTool], client, { agent: "bot" });
    await expect(guarded!.execute({ query: "x" })).rejects.toBeInstanceOf(
      AtlaSentDeniedError,
    );
  });

  it("returns DenialResult on verify failure when onDeny='tool-result'", async () => {
    const client = makeClient({ verifyPermit: vi.fn(async () => VERIFY_REVOKED) });
    const [guarded] = withLlamaIndexGuard([searchTool], client, {
      agent: "bot",
      onDeny: "tool-result",
    });
    const result = (await guarded!.execute({ query: "x" })) as {
      denied: boolean;
      decision: string;
    };
    expect(result.denied).toBe(true);
    expect(result.decision).toBe("verify_failed");
  });

  it("preserves metadata (name, description, parameters)", () => {
    const client = makeClient();
    const [guarded] = withLlamaIndexGuard([searchTool], client, { agent: "bot" });
    expect(guarded!.metadata.name).toBe("vector_search");
    expect(guarded!.metadata.description).toBe("Semantic search over the knowledge base");
    expect(guarded!.metadata.parameters).toEqual(searchTool.metadata.parameters);
  });

  it("does not annotate non-object results", async () => {
    const client = makeClient();
    const [guarded] = withLlamaIndexGuard([countTool], client, { agent: "bot" });
    expect(await guarded!.execute({})).toBe(42);
  });

  it("does not annotate array results", async () => {
    const arrTool: LlamaIndexGuardedTool = {
      metadata: { name: "list", description: "Return a list" },
      execute: async () => ["a", "b"],
    };
    const client = makeClient();
    const [guarded] = withLlamaIndexGuard([arrTool], client, { agent: "bot" });
    expect(await guarded!.execute({})).toEqual(["a", "b"]);
  });

  it("surfaces transport errors as DenialResult when onDeny='tool-result'", async () => {
    const client = makeClient({
      evaluate: vi.fn(async () => { throw new Error("network timeout"); }),
    });
    const [guarded] = withLlamaIndexGuard([searchTool], client, {
      agent: "bot",
      onDeny: "tool-result",
    });
    const result = (await guarded!.execute({ query: "x" })) as {
      denied: boolean;
      reason: string;
    };
    expect(result.denied).toBe(true);
    expect(result.reason).toContain("network timeout");
  });

  it("forwards extraContext to evaluate", async () => {
    const client = makeClient();
    const [guarded] = withLlamaIndexGuard([searchTool], client, {
      agent: "bot",
      extraContext: { env: "prod" },
    });
    await guarded!.execute({ query: "x" });
    expect(client.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        context: { env: "prod", tool: "vector_search", tool_input: { query: "x" } },
      }),
    );
  });

  it("wraps all tools in the array", async () => {
    const client = makeClient();
    const [g1, g2] = withLlamaIndexGuard([searchTool, countTool], client, { agent: "bot" });
    expect(g1!.metadata.name).toBe("vector_search");
    expect(g2!.metadata.name).toBe("count");
    await g1!.execute({ query: "x" });
    await g2!.execute({});
    expect(client.evaluate).toHaveBeenCalledTimes(2);
  });
});
