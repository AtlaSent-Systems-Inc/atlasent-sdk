/**
 * Tool guard: wraps Anthropic tool definitions with AtlaSent authorization.
 *
 * Each tool's `execute` function is intercepted; before the tool runs, the
 * caller's identity and the tool name are evaluated against AtlaSent policy.
 * Denials surface as `AtlaSentDeniedError` (or as a tool-result object if
 * `onDeny: "tool-result"` is set) so the agentic loop can present the outcome
 * to the model.
 */

import type { AtlaSentClient } from "@atlasent/sdk";
import { AtlaSentDeniedError } from "@atlasent/sdk";

// ── Anthropic tool shape (duck-typed to avoid hard import of @anthropic-ai/sdk)

/** Minimal Anthropic tool definition shape. */
export interface AnthropicToolDefinition {
  name: string;
  description?: string;
  input_schema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

// ── GuardedTool ───────────────────────────────────────────────────────────────

/**
 * An Anthropic tool definition extended with an `execute` callback.
 * The guard wraps `execute` with AtlaSent authorization before calling it.
 */
export interface GuardedTool<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput = unknown,
> extends AnthropicToolDefinition {
  execute: (input: TInput) => Promise<TOutput>;
}

// ── Options ───────────────────────────────────────────────────────────────────

type Resolver<T> =
  | T
  | ((toolName: string, toolInput: Record<string, unknown>) => T | Promise<T>);

async function resolve<T>(
  r: Resolver<T>,
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<T> {
  return typeof r === "function"
    ? await (r as (n: string, i: Record<string, unknown>) => T | Promise<T>)(
        toolName,
        toolInput,
      )
    : r;
}

export interface GuardOptions {
  /**
   * Agent identifier for AtlaSent (e.g. `"service:analytics-bot"`).
   * A function receives the tool name and raw input so you can derive
   * the agent from request context captured in a closure.
   */
  agent: Resolver<string>;
  /**
   * Action name sent to the policy engine. Defaults to the tool name.
   * Override when your policy uses different slugs than your tool names.
   */
  action?: Resolver<string>;
  /**
   * Extra key-value context forwarded to every AtlaSent evaluation.
   * The tool input is always included under `tool_input`.
   */
  extraContext?: Resolver<Record<string, unknown>>;
  /**
   * What to do when AtlaSent denies a tool call or when a transport
   * error occurs.
   *
   * - `"throw"` (default) — re-throws `AtlaSentDeniedError` / the
   *   transport error. The loop surfaces this to the caller.
   * - `"tool-result"` — resolves with a `DenialResult` object instead
   *   of throwing, so Claude sees the denial and can adapt its plan.
   */
  onDeny?: "throw" | "tool-result";
}

/** Returned by `execute` when `onDeny: "tool-result"` and the call is denied. */
export interface DenialResult {
  denied: true;
  decision: string;
  evaluationId: string;
  reason: string;
  auditHash?: string;
}

// ── withAtlaSentGuard ─────────────────────────────────────────────────────────

/**
 * Wrap an array of {@link GuardedTool} definitions with AtlaSent authorization.
 *
 * Returns a new array with the same Anthropic-facing fields (`name`,
 * `description`, `input_schema`) but with `execute` replaced by an
 * authorize-first version that calls evaluate + verifyPermit before
 * the original `execute` body runs.
 *
 * @example
 * ```ts
 * const tools = withAtlaSentGuard(
 *   [{
 *     name: "execute_sql",
 *     description: "Run a read-only SQL query",
 *     input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
 *     execute: async ({ query }) => db.query(query),
 *   }],
 *   atlasent,
 *   { agent: "service:analytics-bot" },
 * );
 * ```
 */
export function withAtlaSentGuard<
  T extends GuardedTool<Record<string, unknown>, unknown>,
>(tools: readonly T[], client: AtlaSentClient, options: GuardOptions): T[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async (input: Record<string, unknown>): Promise<unknown> => {
      const agent = await resolve(options.agent, tool.name, input);
      const action = options.action
        ? await resolve(options.action, tool.name, input)
        : tool.name;
      const extra = options.extraContext
        ? await resolve(options.extraContext, tool.name, input)
        : {};
      const context = { ...extra, tool_input: input };

      try {
        // Evaluate
        const evalResp = await client.evaluate({ agent, action, context });

        if (evalResp.decision !== "ALLOW") {
          return handleDenial(options.onDeny, {
            denied: true,
            decision: evalResp.decision,
            evaluationId: evalResp.permitId,
            reason: evalResp.reason,
            auditHash: evalResp.auditHash,
          });
        }

        // Verify
        const verifyResp = await client.verifyPermit({
          permitId: evalResp.permitId,
          agent,
          action,
          context,
        });

        if (!verifyResp.verified) {
          return handleDenial(options.onDeny, {
            denied: true,
            decision: "verify_failed",
            evaluationId: evalResp.permitId,
            reason: `permit verification failed: ${verifyResp.outcome}`,
            auditHash: evalResp.auditHash,
          });
        }

        // Execute — annotate result with permit metadata
        const result = await tool.execute(input as Parameters<T["execute"]>[0]);
        if (result !== null && typeof result === "object") {
          return {
            ...(result as Record<string, unknown>),
            _atlasent_permit_id: evalResp.permitId,
            _atlasent_audit_hash: evalResp.auditHash,
          };
        }
        return result;
      } catch (err) {
        if (err instanceof AtlaSentDeniedError) throw err;
        // Transport / server error
        if ((options.onDeny ?? "throw") === "tool-result") {
          return {
            denied: true,
            decision: "error",
            evaluationId: "",
            reason: err instanceof Error ? err.message : String(err),
          } satisfies DenialResult;
        }
        throw err;
      }
    },
  })) as unknown as T[];
}

function handleDenial(
  onDeny: "throw" | "tool-result" | undefined,
  denial: DenialResult,
): DenialResult {
  if ((onDeny ?? "throw") === "tool-result") return denial;
  throw new AtlaSentDeniedError({
    decision: "deny",
    evaluationId: denial.evaluationId,
    reason: denial.reason,
    ...(denial.auditHash !== undefined ? { auditHash: denial.auditHash } : {}),
  });
}
