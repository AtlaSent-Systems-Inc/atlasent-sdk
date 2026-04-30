import { describe, expect, it, vi } from "vitest";
import type { AtlaSentClient } from "@atlasent/sdk";
import { AtlaSentDeniedError } from "@atlasent/sdk";
import {
  withLlamaIndexGuard,
  type LlamaIndexGuardedTool,
} from "../src/index.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

const ALLOW_EVAL = {
  decision: "ALLOW" as const,
  permitId: "dec_alpha",
  reason: "authorized",
  auditHash: "hash_alpha",
  timestamp: "2026-04-29T10:00:00Z",
  rateLimit: null,
};

const DENY_EVAL = {
  decision: "DENY" as const,
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

function makeClient(overrides: Partial<AtlaSentClient> = {}): AtlaSentClient {
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
  it("executes tool and annotates object result on ALLOW + verified", async () => {
    const client = makeClient();
    const [guarded] = withLlamaIndexGuard([searchTool], client, { agent: "bot" });
    const result = (await guarded!.execute({ query: "hello" })) as Record<string, unknown>;
    expect((result["results"] as string[])[0]).toBe("hello");
    expect(result["_atlasent_permit_id"]).toBe("dec_alpha");
    expect(result["_atlasent_audit_hash"]).toBe("hash_alpha");
  });

  it("calls evaluate with metadata.name as action by default", async () => {
    const client = makeClient();
    const [guarded] = withLlamaIndexGuard([searchTool], client, { agent: "svc:app" });
    await guarded!.execute({ query: "x" });
    expect(client.evaluate).toHaveBeenCalledWith({
      agent: "svc:app",
      action: "vector_search",
      context: { tool_input: { query: "x" } },
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
        context: { env: "prod", tool_input: { query: "x" } },
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
