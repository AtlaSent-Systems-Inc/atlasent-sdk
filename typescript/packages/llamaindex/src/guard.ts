/**
 * AtlaSent authorization wrapper for LlamaIndex tools.
 *
 * Mirrors the LlamaIndex BaseTool / FunctionTool shape:
 *   tool.metadata.{ name, description, parameters? }
 *   tool.call(input) → Promise<unknown>
 *
 * The guard wraps `execute` with authorize-first semantics:
 *   1. evaluate   — check the policy engine
 *   2. verifyPermit — confirm the permit cryptographically
 *   3. execute    — run the tool only if both pass
 *
 * Zero dependency on `llamaindex` — duck-typed so the wrapped `execute`
 * (or the whole returned tool object) works with any LlamaIndex version.
 * Pass the result directly to `FunctionTool.from(guarded.execute, guarded.metadata)`
 * or use it as a BaseTool in an AgentRunner.
 */

import type { AtlaSentClient } from "@atlasent/sdk";
import { AtlaSentDeniedError } from "@atlasent/sdk";

// ── LlamaIndex tool shapes (duck-typed) ───────────────────────────────────────

/** LlamaIndex-style tool metadata. */
export interface LlamaIndexToolMetadata {
  name: string;
  description: string;
  /** JSON Schema for the tool's input parameters. */
  parameters?: Record<string, unknown>;
}

/**
 * A LlamaIndex-style tool definition extended with an `execute` callback.
 * The guard wraps `execute` with AtlaSent authorization.
 *
 * @example
 * ```ts
 * const searchTool: LlamaIndexGuardedTool = {
 *   metadata: {
 *     name: "vector_search",
 *     description: "Semantic search over the knowledge base",
 *     parameters: {
 *       type: "object",
 *       properties: { query: { type: "string" } },
 *       required: ["query"],
 *     },
 *   },
 *   execute: async ({ query }) => vectorStore.search(query),
 * };
 * ```
 */
export interface LlamaIndexGuardedTool<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput = unknown,
> {
  metadata: LlamaIndexToolMetadata;
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

export interface LlamaIndexGuardOptions {
  /** Agent identifier (e.g. `"service:knowledge-bot"`). */
  agent: Resolver<string>;
  /** Action name. Defaults to `tool.metadata.name`. */
  action?: Resolver<string>;
  /** Extra context forwarded to every AtlaSent evaluation. */
  extraContext?: Resolver<Record<string, unknown>>;
  /**
   * - `"throw"` (default) — throw `AtlaSentDeniedError` on denial.
   * - `"tool-result"` — return a `DenialResult` object so the agent
   *   can observe and adapt.
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

// ── withLlamaIndexGuard ───────────────────────────────────────────────────────

/**
 * Wrap an array of {@link LlamaIndexGuardedTool} definitions with AtlaSent
 * authorization. Returns a new array with the same metadata but with
 * `execute` replaced by an authorize-first version.
 *
 * Object results are annotated with `_atlasent_permit_id` and
 * `_atlasent_audit_hash`. Non-object results pass through unchanged.
 *
 * @example
 * ```ts
 * import { FunctionTool } from "llamaindex";
 * import { withLlamaIndexGuard } from "@atlasent/llamaindex";
 *
 * const guarded = withLlamaIndexGuard([searchTool], atlasent, {
 *   agent: "service:knowledge-bot",
 * });
 *
 * const tools = guarded.map((t) =>
 *   FunctionTool.from(t.execute, t.metadata),
 * );
 * ```
 */
export function withLlamaIndexGuard<
  T extends LlamaIndexGuardedTool<Record<string, unknown>, unknown>,
>(
  tools: readonly T[],
  client: AtlaSentClient,
  options: LlamaIndexGuardOptions,
): T[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async (input: Record<string, unknown>): Promise<unknown> => {
      const name = tool.metadata.name;
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

        if (result !== null && typeof result === "object" && !Array.isArray(result)) {
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
