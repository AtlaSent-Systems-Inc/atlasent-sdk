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
 * When `permitRevalidationIntervalMs` is set, the guard also runs a
 * continuous-authorization heartbeat (PROD-D9): it polls
 * `GET /v1/permits/:id/valid` at the configured interval and throws
 * `PermitRevoked` if the permit is revoked mid-execution.
 *
 * Zero dependency on `llamaindex` — duck-typed so the wrapped `execute`
 * (or the whole returned tool object) works with any LlamaIndex version.
 * Pass the result directly to `FunctionTool.from(guarded.execute, guarded.metadata)`
 * or use it as a BaseTool in an AgentRunner.
 */

import type { AtlaSentClient } from "@atlasent/sdk";
import { AtlaSentDeniedError, PermitRevoked } from "@atlasent/sdk";

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
   * State snapshot forwarded to every AtlaSent evaluation.
   *
   * Required when the action class has `requires_state_snapshot = true`
   * (the default for all action classes). Omitting this option causes
   * `SNAPSHOT_REQUIRED` denies. At minimum, pass:
   * `{ source: "your-system", complete: true }`
   */
  stateSnapshot?: Resolver<Record<string, unknown>>;
  /**
   * - `"throw"` (default) — throw `AtlaSentDeniedError` on denial.
   * - `"tool-result"` — return a `DenialResult` object so the agent
   *   can observe and adapt.
   */
  onDeny?: "throw" | "tool-result";
  /**
   * Continuous-authorization heartbeat interval in milliseconds (PROD-D9).
   *
   * When set (minimum 1000 ms), the guard polls `GET /v1/permits/:id/valid`
   * at this interval during tool execution. If the permit is revoked
   * mid-execution, `PermitRevoked` is thrown immediately regardless of
   * `onDeny`. Requires the `AtlaSentClient` to expose `checkPermitValid`
   * (available once atlasent-api ships `GET /v1/permits/:id/valid`).
   */
  permitRevalidationIntervalMs?: number;
}

/** Returned instead of throwing when `onDeny: "tool-result"`. */
export interface DenialResult {
  denied: true;
  decision: string;
  evaluationId: string;
  reason: string;
  auditHash?: string;
}

// ── Heartbeat (PROD-D9 continuous-authorization) ──────────────────────────────

interface PermitValidResponse {
  valid: boolean;
  status: "active" | "expired" | "revoked" | "consumed";
  revoked_at?: string;
  revocation_id?: string;
}

type ClientWithHeartbeat = AtlaSentClient & {
  checkPermitValid?: (permitId: string) => Promise<PermitValidResponse>;
};

interface HeartbeatHandle {
  revocationSignal: Promise<never>;
  stop: () => void;
}

function startHeartbeat(
  client: AtlaSentClient,
  permitId: string,
  intervalMs: number,
): HeartbeatHandle {
  const clampedMs = Math.max(intervalMs, 1000);
  let stopped = false;
  let rejectFn: ((e: PermitRevoked) => void) | undefined;
  const revocationSignal = new Promise<never>((_, reject) => {
    rejectFn = reject;
  });

  const extended = client as ClientWithHeartbeat;
  if (!extended.checkPermitValid) {
    return { revocationSignal, stop: () => { stopped = true; } };
  }

  const timer = setInterval(() => {
    if (stopped) return;
    void (extended.checkPermitValid!(permitId)
      .then((resp) => {
        if (!stopped && resp.status === "revoked") {
          stopped = true;
          clearInterval(timer);
          rejectFn!(new PermitRevoked(permitId, resp.revocation_id));
        }
      })
      .catch(() => {
        // Network error during heartbeat poll — continue polling.
      }));
  }, clampedMs);

  return {
    revocationSignal,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
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
 *   permitRevalidationIntervalMs: 5000,
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
      const context: Record<string, unknown> = { ...extra, tool_input: input };
      const stateSnapshot = options.stateSnapshot
        ? await resolve(options.stateSnapshot, name, input)
        : undefined;
      const verifyEnvironment =
        typeof context.environment === "string"
          ? context.environment
          : typeof context.environment_name === "string"
            ? context.environment_name
            : undefined;

      try {
        const evalResp = await client.evaluate({
          agent,
          action,
          context,
          ...(stateSnapshot !== undefined ? { state_snapshot: stateSnapshot } : {}),
        } as Parameters<typeof client.evaluate>[0]);

        if (evalResp.decision !== "allow") {
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
          ...(verifyEnvironment !== undefined
            ? { environment: verifyEnvironment }
            : {}),
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

        // Start continuous-authorization heartbeat (PROD-D9).
        const hb =
          options.permitRevalidationIntervalMs != null
            ? startHeartbeat(client, evalResp.permitId, options.permitRevalidationIntervalMs)
            : null;

        const result = await (hb
          ? Promise.race([
              tool.execute(input as Parameters<T["execute"]>[0]),
              hb.revocationSignal,
            ]).finally(() => hb.stop())
          : tool.execute(input as Parameters<T["execute"]>[0]));

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
        if (err instanceof PermitRevoked) throw err;
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
