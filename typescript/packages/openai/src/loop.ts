/**
 * Agentic tool-call loop for the OpenAI SDK with AtlaSent-guarded tools.
 *
 * Handles the standard OpenAI tool-use cycle:
 *   1. POST to chat.completions.create
 *   2. For each `tool_calls` entry, dispatch to the matching tool
 *      (AtlaSent authorization runs inside the tool's `execute`)
 *   3. Append assistant message + tool results, POST again
 *   4. Repeat until `finish_reason === "stop"` or the turn cap
 */

import type { OpenAIGuardedTool } from "./guard.js";

// ── Minimal OpenAI SDK types (duck-typed) ─────────────────────────────────────

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface AssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
}

interface Choice {
  message: AssistantMessage;
  finish_reason: string | null;
}

interface ChatCompletion {
  id: string;
  choices: Choice[];
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

type MessageParam =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface OpenAITool {
  type: "function";
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

interface CompletionCreateParams {
  model: string;
  messages: MessageParam[];
  tools?: OpenAITool[];
  max_tokens?: number;
  [key: string]: unknown;
}

interface OpenAICompletions {
  create(params: CompletionCreateParams): Promise<ChatCompletion>;
}

interface OpenAIChat {
  completions: OpenAICompletions;
}

interface OpenAIClient {
  chat: OpenAIChat;
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface RunOpenAIGuardedLoopOptions {
  openai: OpenAIClient;
  model: string;
  messages: MessageParam[];
  tools: OpenAIGuardedTool[];
  system?: string;
  maxTokens?: number;
  /** Maximum tool-call turns. Default: 10. */
  maxTurns?: number;
  extra?: Record<string, unknown>;
}

export interface RunOpenAIGuardedLoopResult {
  finalCompletion: ChatCompletion;
  turns: number;
}

// ── runOpenAIGuardedLoop ──────────────────────────────────────────────────────

/**
 * Run the OpenAI tool-use loop, dispatching every tool call through
 * AtlaSent-guarded `execute` functions.
 *
 * @example
 * ```ts
 * const { finalCompletion } = await runOpenAIGuardedLoop({
 *   openai,
 *   model: "gpt-4o",
 *   messages: [{ role: "user", content: "Query the analytics table" }],
 *   tools: guardedTools,
 * });
 * ```
 */
export async function runOpenAIGuardedLoop(
  options: RunOpenAIGuardedLoopOptions,
): Promise<RunOpenAIGuardedLoopResult> {
  const {
    openai,
    model,
    messages,
    tools,
    system,
    maxTokens,
    maxTurns = 10,
    extra = {},
  } = options;

  const toolIndex = new Map(tools.map((t) => [t.function.name, t]));

  const openaiTools: OpenAITool[] = tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.function.name,
      ...(t.function.description !== undefined
        ? { description: t.function.description }
        : {}),
      ...(t.function.parameters !== undefined
        ? { parameters: t.function.parameters }
        : {}),
    },
  }));

  let turns = 0;

  for (;;) {
    // Build the API message list; prepend system message each call without mutating messages.
    const apiMessages: MessageParam[] = system
      ? [{ role: "system", content: system }, ...messages]
      : [...messages];

    const params: CompletionCreateParams = {
      model,
      messages: apiMessages,
      tools: openaiTools,
      ...extra,
    };
    if (maxTokens !== undefined) params.max_tokens = maxTokens;

    const completion = await openai.chat.completions.create(params);
    const choice = completion.choices[0];
    if (!choice) return { finalCompletion: completion, turns };

    messages.push({
      role: "assistant",
      content: choice.message.content,
      ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls } : {}),
    });

    if (choice.finish_reason !== "tool_calls" || !choice.message.tool_calls?.length) {
      return { finalCompletion: completion, turns };
    }

    if (turns >= maxTurns) {
      return { finalCompletion: completion, turns };
    }
    turns++;

    for (const tc of choice.message.tool_calls) {
      const tool = toolIndex.get(tc.function.name);
      let content: string;

      if (!tool) {
        content = JSON.stringify({ error: `Unknown tool: ${tc.function.name}` });
      } else {
        let input: Record<string, unknown>;
        try {
          input = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          content = JSON.stringify({ error: "Invalid tool arguments JSON" });
          messages.push({ role: "tool", tool_call_id: tc.id, content });
          continue;
        }

        try {
          const result = await tool.execute(input);
          content = JSON.stringify(result);
        } catch (err) {
          content = JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      messages.push({ role: "tool", tool_call_id: tc.id, content });
    }
  }
}
