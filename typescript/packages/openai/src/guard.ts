/**
 * Tool guard for the OpenAI SDK.
 *
 * Mirrors @atlasent/anthropic-middleware's API but speaks OpenAI's
 * tool-definition shape (`function.parameters` JSON Schema) and tool-call
 * wire format (`tool_calls[].function.arguments` string).
 */

import type { AtlaSentClient } from "@atlasent/sdk";
import { AtlaSentDeniedError } from "@atlasent/sdk";

// ── OpenAI tool shapes (duck-typed) ───────────────────────────────────────────

/** Minimal OpenAI function-tool definition. */
export interface OpenAIFunctionDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

// ── OpenAIGuardedTool ─────────────────────────────────────────────────────────

/**
 * An OpenAI function-tool definition extended with an `execute` callback.
 * The guard wraps `execute` with AtlaSent authorization.
 */
export interface OpenAIGuardedTool<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput = unknown,
> extends OpenAIFunctionDefinition {
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

export interface OpenAIGuardOptions {
  /** Agent identifier (e.g. `"service:analytics-bot"`). */
  agent: Resolver<string>;
  /** Action name. Defaults to the tool's function name. */
  action?: Resolver<string>;
  /** Extra context forwarded to every AtlaSent evaluation. */
  extraContext?: Resolver<Record<string, unknown>>;
  /**
   * - `"throw"` (default) — throw `AtlaSentDeniedError` on denial.
   * - `"tool-result"` — return a `DenialResult` so the model can adapt.
   */
  onDeny?: "throw" | "tool-result";
}

/** Returned instead of throwing when `onDeny: "tool-result"`. */
export interface DenialResult {
  denied: true;
  decision: string;
  evaluationId: string;
  reason: string;
  auditHash?: string;
}

// ── withOpenAIGuard ───────────────────────────────────────────────────────────

/**
 * Wrap an array of {@link OpenAIGuardedTool} definitions with AtlaSent
 * authorization. Returns a new array with the same OpenAI-facing fields but
 * with `execute` replaced by an authorize-first version.
 *
 * @example
 * ```ts
 * const tools = withOpenAIGuard(
 *   [{
 *     type: "function",
 *     function: {
 *       name: "execute_sql",
 *       description: "Run a read-only SQL query",
 *       parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
 *     },
 *     execute: async ({ query }) => db.query(query),
 *   }],
 *   atlasent,
 *   { agent: "service:analytics-bot" },
 * );
 * ```
 */
export function withOpenAIGuard<
  T extends OpenAIGuardedTool<Record<string, unknown>, unknown>,
>(tools: readonly T[], client: AtlaSentClient, options: OpenAIGuardOptions): T[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async (input: Record<string, unknown>): Promise<unknown> => {
      const name = tool.function.name;
      const agent = await resolve(options.agent, name, input);
      const action = options.action
        ? await resolve(options.action, name, input)
        : name;
      const extra = options.extraContext
        ? await resolve(options.extraContext, name, input)
        : {};
      const context = { ...extra, tool_input: input };

      try {
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
