/**
 * Agentic tool-call loop for the Anthropic SDK with AtlaSent-guarded tools.
 *
 * `runGuardedLoop` handles the standard Claude tool-use cycle:
 *   1. POST to messages.create
 *   2. For each `tool_use` block, dispatch to the matching {@link GuardedTool}
 *      (AtlaSent authorization runs inside the tool's `execute`)
 *   3. Append the assistant turn + all tool results, POST again
 *   4. Repeat until `stop_reason === "end_turn"` or the iteration cap
 */

import type { GuardedTool } from "./guard.js";

// ── Minimal Anthropic SDK types (duck-typed) ──────────────────────────────────

interface ContentBlockToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ContentBlockText {
  type: "text";
  text: string;
}

type ContentBlock = ContentBlockToolUse | ContentBlockText | { type: string };

interface Message {
  id: string;
  role: "assistant";
  content: ContentBlock[];
  stop_reason: string | null;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
}

interface MessageParam {
  role: "user" | "assistant";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "tool_result"; tool_use_id: string; content: string }
        | ContentBlock
      >;
}

interface MessagesCreateParams {
  model: string;
  max_tokens?: number;
  messages: MessageParam[];
  tools?: AnthropicTool[];
  system?: string;
  [key: string]: unknown;
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicMessages {
  create(params: MessagesCreateParams): Promise<Message>;
}

interface AnthropicClient {
  messages: AnthropicMessages;
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface RunGuardedLoopOptions {
  /** The Anthropic client instance. */
  anthropic: AnthropicClient;
  /** Model to use (e.g. `"claude-opus-4-7"`). */
  model: string;
  /** Initial messages array. Extended in-place across turns. */
  messages: MessageParam[];
  /** Guarded tools (output of {@link withAtlaSentGuard}). */
  tools: GuardedTool[];
  /** System prompt. */
  system?: string;
  /** Max tokens per response. Default: 4096. */
  maxTokens?: number;
  /**
   * Maximum agentic turns (tool call → result loops). Default: 10.
   * Prevents infinite loops in runaway agent plans.
   */
  maxTurns?: number;
  /** Additional Anthropic parameters forwarded verbatim. */
  extra?: Record<string, unknown>;
}

export interface RunGuardedLoopResult {
  /** The final assistant `Message` that ended with `stop_reason: "end_turn"`. */
  finalMessage: Message;
  /** Total number of tool-call turns taken. */
  turns: number;
}

// ── runGuardedLoop ────────────────────────────────────────────────────────────

/**
 * Run the Claude tool-use loop, dispatching every tool call through
 * AtlaSent-guarded `execute` functions.
 *
 * @example
 * ```ts
 * const { finalMessage } = await runGuardedLoop({
 *   anthropic,
 *   model: "claude-opus-4-7",
 *   messages: [{ role: "user", content: "Query the analytics table" }],
 *   tools: guardedTools,
 * });
 * console.log(finalMessage.content);
 * ```
 */
export async function runGuardedLoop(
  options: RunGuardedLoopOptions,
): Promise<RunGuardedLoopResult> {
  const {
    anthropic,
    model,
    messages,
    tools,
    system,
    maxTokens = 4_096,
    maxTurns = 10,
    extra = {},
  } = options;

  const toolIndex = new Map(tools.map((t) => [t.name, t]));

  const anthropicTools: AnthropicTool[] = tools.map((t) => ({
    name: t.name,
    ...(t.description !== undefined ? { description: t.description } : {}),
    input_schema: t.input_schema,
  }));

  let turns = 0;

  for (;;) {
    const params: MessagesCreateParams = {
      model,
      max_tokens: maxTokens,
      messages: [...messages],
      tools: anthropicTools,
      ...extra,
    };
    if (system !== undefined) params.system = system;

    const response = await anthropic.messages.create(params);

    // Append assistant turn to history.
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      return { finalMessage: response, turns };
    }

    if (turns >= maxTurns) {
      return { finalMessage: response, turns };
    }
    turns++;

    // Dispatch all tool calls in this turn.
    const toolResults: Array<{
      type: "tool_result";
      tool_use_id: string;
      content: string;
    }> = [];

    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const toolUse = block as ContentBlockToolUse;
      const tool = toolIndex.get(toolUse.name);

      let resultContent: string;
      if (!tool) {
        resultContent = JSON.stringify({ error: `Unknown tool: ${toolUse.name}` });
      } else {
        try {
          const result = await tool.execute(toolUse.input);
          resultContent = JSON.stringify(result);
        } catch (err) {
          resultContent = JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: resultContent,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }
}
