import { describe, expect, it, vi } from "vitest";
import type { AtlaSentClient } from "@atlasent/sdk";
import { AtlaSentDeniedError } from "@atlasent/sdk";
import {
  withAtlaSentGuard,
  runGuardedLoop,
  type GuardedTool,
  type RunGuardedLoopOptions,
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

const echoTool: GuardedTool = {
  name: "echo",
  description: "Echo a value",
  input_schema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  },
  execute: async (input) => ({ echoed: (input as { value: string }).value }),
};

// ── withAtlaSentGuard ─────────────────────────────────────────────────────────

describe("withAtlaSentGuard", () => {
  it("executes tool and annotates result on ALLOW + verified", async () => {
    const client = makeClient();
    const [guarded] = withAtlaSentGuard([echoTool], client, {
      agent: "bot",
    });
    const result = (await guarded!.execute({ value: "hello" })) as Record<
      string,
      unknown
    >;
    expect(result.echoed).toBe("hello");
    expect(result._atlasent_permit_id).toBe("dec_alpha");
    expect(result._atlasent_audit_hash).toBe("hash_alpha");
  });

  it("calls evaluate with correct agent, action, and context", async () => {
    const client = makeClient();
    const [guarded] = withAtlaSentGuard([echoTool], client, {
      agent: "svc:my-agent",
      extraContext: { env: "prod" },
    });
    await guarded!.execute({ value: "x" });
    expect(client.evaluate).toHaveBeenCalledWith({
      agent: "svc:my-agent",
      action: "echo",
      context: { env: "prod", tool_input: { value: "x" } },
    });
  });

  it("uses custom action resolver", async () => {
    const client = makeClient();
    const [guarded] = withAtlaSentGuard([echoTool], client, {
      agent: "bot",
      action: (name) => `tool:${name}`,
    });
    await guarded!.execute({ value: "x" });
    expect(client.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ action: "tool:echo" }),
    );
  });

  it("derives agent from function", async () => {
    const client = makeClient();
    const [guarded] = withAtlaSentGuard([echoTool], client, {
      agent: (toolName, _input) => `svc:${toolName}-runner`,
    });
    await guarded!.execute({ value: "x" });
    expect(client.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "svc:echo-runner" }),
    );
  });

  it("throws AtlaSentDeniedError on DENY by default", async () => {
    const client = makeClient({
      evaluate: vi.fn(async () => DENY_EVAL),
    });
    const [guarded] = withAtlaSentGuard([echoTool], client, { agent: "bot" });
    await expect(guarded!.execute({ value: "x" })).rejects.toBeInstanceOf(
      AtlaSentDeniedError,
    );
    expect(client.verifyPermit).not.toHaveBeenCalled();
  });

  it("returns DenialResult on DENY when onDeny='tool-result'", async () => {
    const client = makeClient({
      evaluate: vi.fn(async () => DENY_EVAL),
    });
    const [guarded] = withAtlaSentGuard([echoTool], client, {
      agent: "bot",
      onDeny: "tool-result",
    });
    const result = (await guarded!.execute({ value: "x" })) as {
      denied: boolean;
    };
    expect(result.denied).toBe(true);
    expect(client.verifyPermit).not.toHaveBeenCalled();
  });

  it("throws AtlaSentDeniedError on verify failure by default", async () => {
    const client = makeClient({
      verifyPermit: vi.fn(async () => VERIFY_REVOKED),
    });
    const [guarded] = withAtlaSentGuard([echoTool], client, { agent: "bot" });
    await expect(guarded!.execute({ value: "x" })).rejects.toBeInstanceOf(
      AtlaSentDeniedError,
    );
  });

  it("returns DenialResult on verify failure when onDeny='tool-result'", async () => {
    const client = makeClient({
      verifyPermit: vi.fn(async () => VERIFY_REVOKED),
    });
    const [guarded] = withAtlaSentGuard([echoTool], client, {
      agent: "bot",
      onDeny: "tool-result",
    });
    const result = (await guarded!.execute({ value: "x" })) as {
      denied: boolean;
      decision: string;
    };
    expect(result.denied).toBe(true);
    expect(result.decision).toBe("verify_failed");
  });

  it("preserves tool name, description, and input_schema", () => {
    const client = makeClient();
    const [guarded] = withAtlaSentGuard([echoTool], client, { agent: "bot" });
    expect(guarded!.name).toBe("echo");
    expect(guarded!.description).toBe("Echo a value");
    expect(guarded!.input_schema).toEqual(echoTool.input_schema);
  });

  it("does not annotate non-object results", async () => {
    const strTool: GuardedTool = {
      name: "stringify",
      input_schema: { type: "object" },
      execute: async () => "raw string",
    };
    const client = makeClient();
    const [guarded] = withAtlaSentGuard([strTool], client, { agent: "bot" });
    const result = await guarded!.execute({});
    expect(result).toBe("raw string");
  });

  it("surfaces transport errors as DenialResult when onDeny='tool-result'", async () => {
    const client = makeClient({
      evaluate: vi.fn(async () => {
        throw new Error("network failure");
      }),
    });
    const [guarded] = withAtlaSentGuard([echoTool], client, {
      agent: "bot",
      onDeny: "tool-result",
    });
    const result = (await guarded!.execute({ value: "x" })) as {
      denied: boolean;
      reason: string;
    };
    expect(result.denied).toBe(true);
    expect(result.reason).toContain("network failure");
  });
});

// ── runGuardedLoop ─────────────────────────────────────────────────────────────

describe("runGuardedLoop", () => {
  function makeAnthropicClient(
    responses: Array<{
      stop_reason: string;
      content: Array<{ type: string; [k: string]: unknown }>;
    }>,
  ) {
    const queue = [...responses];
    return {
      messages: {
        create: vi.fn(async () => {
          const next = queue.shift();
          if (!next) throw new Error("mock queue exhausted");
          return {
            id: "msg_test",
            role: "assistant" as const,
            model: "claude-opus-4-7",
            usage: { input_tokens: 10, output_tokens: 20 },
            ...next,
          };
        }),
      },
    };
  }

  it("returns immediately on end_turn with no tool use", async () => {
    const anthropic = makeAnthropicClient([
      { stop_reason: "end_turn", content: [{ type: "text", text: "Done" }] },
    ]);
    const atlasent = makeClient();
    const tools = withAtlaSentGuard([echoTool], atlasent, { agent: "bot" });

    const options: RunGuardedLoopOptions = {
      anthropic,
      model: "claude-opus-4-7",
      messages: [{ role: "user", content: "Hello" }],
      tools,
    };
    const { finalMessage, turns } = await runGuardedLoop(options);
    expect(finalMessage.stop_reason).toBe("end_turn");
    expect(turns).toBe(0);
    expect(anthropic.messages.create).toHaveBeenCalledTimes(1);
  });

  it("dispatches tool_use blocks and loops", async () => {
    const anthropic = makeAnthropicClient([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "echo",
            input: { value: "ping" },
          },
        ],
      },
      { stop_reason: "end_turn", content: [{ type: "text", text: "pong" }] },
    ]);
    const atlasent = makeClient();
    const tools = withAtlaSentGuard([echoTool], atlasent, { agent: "bot" });
    const messages: RunGuardedLoopOptions["messages"] = [
      { role: "user", content: "Echo ping" },
    ];

    const { turns } = await runGuardedLoop({
      anthropic,
      model: "claude-opus-4-7",
      messages,
      tools,
    });
    expect(turns).toBe(1);
    expect(anthropic.messages.create).toHaveBeenCalledTimes(2);
    // The tool result should have been appended to messages
    const toolResultTurn = messages.find(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        (m.content as Array<{ type: string }>)[0]?.type === "tool_result",
    );
    expect(toolResultTurn).toBeDefined();
  });

  it("includes tool deny error in tool result when onDeny='tool-result'", async () => {
    const anthropic = makeAnthropicClient([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "tu_deny",
            name: "echo",
            input: { value: "secret" },
          },
        ],
      },
      { stop_reason: "end_turn", content: [{ type: "text", text: "sorry" }] },
    ]);
    const atlasent = makeClient({
      evaluate: vi.fn(async () => DENY_EVAL),
    });
    const tools = withAtlaSentGuard([echoTool], atlasent, {
      agent: "bot",
      onDeny: "tool-result",
    });
    const messages: RunGuardedLoopOptions["messages"] = [
      { role: "user", content: "Echo secret" },
    ];

    await runGuardedLoop({
      anthropic,
      model: "claude-opus-4-7",
      messages,
      tools,
    });

    const toolResultTurn = messages.find(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        (m.content as Array<{ type: string }>)[0]?.type === "tool_result",
    );
    expect(toolResultTurn).toBeDefined();
    const content = (
      toolResultTurn!.content as Array<{
        type: string;
        content: string;
      }>
    )[0]!.content;
    expect(JSON.parse(content)).toMatchObject({ denied: true });
  });

  it("stops at maxTurns", async () => {
    const anthropic = makeAnthropicClient(
      Array.from({ length: 4 }, () => ({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "tu_x", name: "echo", input: { value: "x" } }],
      })),
    );
    const atlasent = makeClient();
    const tools = withAtlaSentGuard([echoTool], atlasent, { agent: "bot" });

    const { turns } = await runGuardedLoop({
      anthropic,
      model: "claude-opus-4-7",
      messages: [{ role: "user", content: "loop" }],
      tools,
      maxTurns: 2,
    });
    expect(turns).toBe(2);
  });
});
