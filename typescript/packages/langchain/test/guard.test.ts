import { describe, expect, it, vi } from "vitest";
import type { AtlaSentClient } from "@atlasent/sdk";
import { AtlaSentDeniedError } from "@atlasent/sdk";
import {
  withLangChainGuard,
  type LangChainGuardedTool,
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
  it("executes tool and annotates JSON result on ALLOW + verified", async () => {
    const client = makeClient();
    const [guarded] = withLangChainGuard([queryTool], client, { agent: "bot" });
    const raw = await guarded!.execute({ sql: "SELECT 1" });
    const result = JSON.parse(raw) as Record<string, unknown>;
    expect(result["rows"]).toEqual(["SELECT 1"]);
    expect(result["_atlasent_permit_id"]).toBe("dec_alpha");
    expect(result["_atlasent_audit_hash"]).toBe("hash_alpha");
  });

  it("calls evaluate with tool name as action by default", async () => {
    const client = makeClient();
    const [guarded] = withLangChainGuard([queryTool], client, { agent: "svc:app" });
    await guarded!.execute({ sql: "SELECT 1" });
    expect(client.evaluate).toHaveBeenCalledWith({
      agent: "svc:app",
      action: "query_db",
      context: { tool_input: { sql: "SELECT 1" } },
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
        context: { env: "prod", tool_input: { sql: "SELECT 1" } },
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
