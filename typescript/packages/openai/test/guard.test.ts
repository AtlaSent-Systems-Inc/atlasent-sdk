import { describe, expect, it, vi } from "vitest";
import type { AtlaSentClient } from "@atlasent/sdk";
import { AtlaSentDeniedError } from "@atlasent/sdk";
import {
  withOpenAIGuard,
  runOpenAIGuardedLoop,
  type OpenAIGuardedTool,
  type RunOpenAIGuardedLoopOptions,
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

const echoTool: OpenAIGuardedTool = {
  type: "function",
  function: {
    name: "echo",
    description: "Echo a value",
    parameters: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
  },
  execute: async (input) => ({ echoed: (input as { value: string }).value }),
};

// ── withOpenAIGuard ───────────────────────────────────────────────────────────

describe("withOpenAIGuard", () => {
  it("executes tool and annotates result on ALLOW + verified", async () => {
    const client = makeClient();
    const [guarded] = withOpenAIGuard([echoTool], client, { agent: "bot" });
    const result = (await guarded!.execute({ value: "hello" })) as Record<string, unknown>;
    expect(result.echoed).toBe("hello");
    expect(result._atlasent_permit_id).toBe("dec_alpha");
    expect(result._atlasent_audit_hash).toBe("hash_alpha");
  });

  it("calls evaluate with function name as action by default", async () => {
    const client = makeClient();
    const [guarded] = withOpenAIGuard([echoTool], client, { agent: "svc:app" });
    await guarded!.execute({ value: "x" });
    expect(client.evaluate).toHaveBeenCalledWith({
      agent: "svc:app",
      action: "echo",
      context: { tool_input: { value: "x" } },
    });
  });

  it("uses custom action resolver", async () => {
    const client = makeClient();
    const [guarded] = withOpenAIGuard([echoTool], client, {
      agent: "bot",
      action: (name) => `fn:${name}`,
    });
    await guarded!.execute({ value: "x" });
    expect(client.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ action: "fn:echo" }),
    );
  });

  it("throws AtlaSentDeniedError on DENY by default", async () => {
    const client = makeClient({ evaluate: vi.fn(async () => DENY_EVAL) });
    const [guarded] = withOpenAIGuard([echoTool], client, { agent: "bot" });
    await expect(guarded!.execute({ value: "x" })).rejects.toBeInstanceOf(
      AtlaSentDeniedError,
    );
    expect(client.verifyPermit).not.toHaveBeenCalled();
  });

  it("returns DenialResult on DENY when onDeny='tool-result'", async () => {
    const client = makeClient({ evaluate: vi.fn(async () => DENY_EVAL) });
    const [guarded] = withOpenAIGuard([echoTool], client, {
      agent: "bot",
      onDeny: "tool-result",
    });
    const result = (await guarded!.execute({ value: "x" })) as { denied: boolean };
    expect(result.denied).toBe(true);
  });

  it("throws on verify failure by default", async () => {
    const client = makeClient({ verifyPermit: vi.fn(async () => VERIFY_REVOKED) });
    const [guarded] = withOpenAIGuard([echoTool], client, { agent: "bot" });
    await expect(guarded!.execute({ value: "x" })).rejects.toBeInstanceOf(
      AtlaSentDeniedError,
    );
  });

  it("returns DenialResult on verify failure when onDeny='tool-result'", async () => {
    const client = makeClient({ verifyPermit: vi.fn(async () => VERIFY_REVOKED) });
    const [guarded] = withOpenAIGuard([echoTool], client, {
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

  it("preserves type, function.name, description, and parameters", () => {
    const client = makeClient();
    const [guarded] = withOpenAIGuard([echoTool], client, { agent: "bot" });
    expect(guarded!.type).toBe("function");
    expect(guarded!.function.name).toBe("echo");
    expect(guarded!.function.description).toBe("Echo a value");
    expect(guarded!.function.parameters).toEqual(echoTool.function.parameters);
  });

  it("does not annotate non-object results", async () => {
    const numTool: OpenAIGuardedTool = {
      type: "function",
      function: { name: "count" },
      execute: async () => 42,
    };
    const client = makeClient();
    const [guarded] = withOpenAIGuard([numTool], client, { agent: "bot" });
    expect(await guarded!.execute({})).toBe(42);
  });

  it("surfaces transport errors as DenialResult when onDeny='tool-result'", async () => {
    const client = makeClient({
      evaluate: vi.fn(async () => { throw new Error("timeout"); }),
    });
    const [guarded] = withOpenAIGuard([echoTool], client, {
      agent: "bot",
      onDeny: "tool-result",
    });
    const result = (await guarded!.execute({ value: "x" })) as { denied: boolean; reason: string };
    expect(result.denied).toBe(true);
    expect(result.reason).toContain("timeout");
  });
});

// ── runOpenAIGuardedLoop ──────────────────────────────────────────────────────

describe("runOpenAIGuardedLoop", () => {
  function makeCompletion(
    finishReason: string,
    content: string | null,
    toolCalls?: Array<{ id: string; name: string; arguments: string }>,
  ) {
    return {
      id: "cmpl_test",
      model: "gpt-4o",
      usage: { prompt_tokens: 10, completion_tokens: 20 },
      choices: [
        {
          finish_reason: finishReason,
          message: {
            role: "assistant" as const,
            content,
            ...(toolCalls
              ? {
                  tool_calls: toolCalls.map((tc) => ({
                    id: tc.id,
                    type: "function" as const,
                    function: { name: tc.name, arguments: tc.arguments },
                  })),
                }
              : {}),
          },
        },
      ],
    };
  }

  function makeOpenAIClient(completions: ReturnType<typeof makeCompletion>[]) {
    const queue = [...completions];
    return {
      chat: {
        completions: {
          create: vi.fn(async () => {
            const next = queue.shift();
            if (!next) throw new Error("queue exhausted");
            return next;
          }),
        },
      },
    };
  }

  it("returns on stop finish_reason with no tool calls", async () => {
    const openai = makeOpenAIClient([makeCompletion("stop", "Done")]);
    const atlasent = makeClient();
    const tools = withOpenAIGuard([echoTool], atlasent, { agent: "bot" });

    const { finalCompletion, turns } = await runOpenAIGuardedLoop({
      openai,
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
      tools,
    } as RunOpenAIGuardedLoopOptions);

    expect(finalCompletion.choices[0]!.finish_reason).toBe("stop");
    expect(turns).toBe(0);
    expect(openai.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  it("dispatches tool_calls and loops", async () => {
    const openai = makeOpenAIClient([
      makeCompletion("tool_calls", null, [
        { id: "tc_1", name: "echo", arguments: JSON.stringify({ value: "ping" }) },
      ]),
      makeCompletion("stop", "pong"),
    ]);
    const atlasent = makeClient();
    const tools = withOpenAIGuard([echoTool], atlasent, { agent: "bot" });
    const messages: RunOpenAIGuardedLoopOptions["messages"] = [
      { role: "user", content: "Echo ping" },
    ];

    const { turns } = await runOpenAIGuardedLoop({
      openai,
      model: "gpt-4o",
      messages,
      tools,
    } as RunOpenAIGuardedLoopOptions);

    expect(turns).toBe(1);
    expect(openai.chat.completions.create).toHaveBeenCalledTimes(2);
    const toolMsg = messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(JSON.parse((toolMsg as { content: string }).content)).toMatchObject({
      echoed: "ping",
    });
  });

  it("appends denial as tool result when onDeny='tool-result'", async () => {
    const openai = makeOpenAIClient([
      makeCompletion("tool_calls", null, [
        { id: "tc_deny", name: "echo", arguments: JSON.stringify({ value: "secret" }) },
      ]),
      makeCompletion("stop", "sorry"),
    ]);
    const atlasent = makeClient({ evaluate: vi.fn(async () => DENY_EVAL) });
    const tools = withOpenAIGuard([echoTool], atlasent, {
      agent: "bot",
      onDeny: "tool-result",
    });
    const messages: RunOpenAIGuardedLoopOptions["messages"] = [
      { role: "user", content: "Echo secret" },
    ];

    await runOpenAIGuardedLoop({
      openai, model: "gpt-4o", messages, tools,
    } as RunOpenAIGuardedLoopOptions);

    const toolMsg = messages.find((m) => m.role === "tool");
    expect(JSON.parse((toolMsg as { content: string }).content)).toMatchObject({ denied: true });
  });

  it("returns error tool result for malformed arguments JSON", async () => {
    const openai = makeOpenAIClient([
      makeCompletion("tool_calls", null, [
        { id: "tc_bad", name: "echo", arguments: "not-json" },
      ]),
      makeCompletion("stop", "ok"),
    ]);
    const atlasent = makeClient();
    const tools = withOpenAIGuard([echoTool], atlasent, { agent: "bot" });
    const messages: RunOpenAIGuardedLoopOptions["messages"] = [
      { role: "user", content: "go" },
    ];

    await runOpenAIGuardedLoop({ openai, model: "gpt-4o", messages, tools } as RunOpenAIGuardedLoopOptions);

    const toolMsg = messages.find((m) => m.role === "tool");
    expect(JSON.parse((toolMsg as { content: string }).content)).toMatchObject({
      error: expect.stringContaining("Invalid"),
    });
  });

  it("stops at maxTurns", async () => {
    const openai = makeOpenAIClient(
      Array.from({ length: 5 }, () =>
        makeCompletion("tool_calls", null, [
          { id: "tc_x", name: "echo", arguments: JSON.stringify({ value: "x" }) },
        ]),
      ),
    );
    const atlasent = makeClient();
    const tools = withOpenAIGuard([echoTool], atlasent, { agent: "bot" });

    const { turns } = await runOpenAIGuardedLoop({
      openai, model: "gpt-4o",
      messages: [{ role: "user", content: "loop" }],
      tools,
      maxTurns: 3,
    } as RunOpenAIGuardedLoopOptions);

    expect(turns).toBe(3);
  });

  it("prepends system message when provided", async () => {
    const openai = makeOpenAIClient([makeCompletion("stop", "ok")]);
    const atlasent = makeClient();
    const tools = withOpenAIGuard([echoTool], atlasent, { agent: "bot" });
    const messages: RunOpenAIGuardedLoopOptions["messages"] = [
      { role: "user", content: "hi" },
    ];

    await runOpenAIGuardedLoop({
      openai, model: "gpt-4o", messages, tools, system: "Be helpful.",
    } as RunOpenAIGuardedLoopOptions);

    const createArgs = vi.mocked(openai.chat.completions.create).mock.calls as unknown as Array<[{ messages: Array<{ role: string }> }]>;
    expect(createArgs[0]![0]!.messages[0]!.role).toBe("system");
  });
});
