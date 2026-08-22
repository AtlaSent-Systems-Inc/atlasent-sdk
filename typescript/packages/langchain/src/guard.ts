/**
 * AtlaSent authorization wrapper for LangChain tools.
 *
 * Works with any LangChain tool factory (DynamicStructuredTool,
 * DynamicTool, custom Tool subclasses) by wrapping the underlying
 * `execute` / `func` callback with authorize-first semantics:
 *   1. evaluate — check the policy engine
 *   2. verifyPermit — confirm the permit cryptographically
 *   3. execute — run the tool only if both pass
 *
 * When `permitRevalidationIntervalMs` is set, the guard also runs a
 * continuous-authorization heartbeat (PROD-D9): it polls
 * `GET /v1/permits/:id/valid` at the configured interval and throws
 * `PermitRevoked` if the permit is revoked mid-execution.
 *
 * The package is zero-dependency on @langchain/core — it operates on
 * plain objects. Pass the wrapped `execute` to whichever LangChain
 * tool constructor you prefer.
 */

import type { AtlaSentClient } from "@atlasent/sdk";
import { AtlaSentDeniedError, PermitRevoked } from "@atlasent/sdk";

// ── LangChain tool shapes (duck-typed) ────────────────────────────────────────

/** Minimal JSON Schema for a LangChain structured tool's input. */
export interface LangChainToolSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

/**
 * A LangChain-style tool definition extended with an `execute` callback.
 * LangChain tools return strings; the guard annotates the string result
 * with permit metadata when the output format allows it (i.e. when the
 * result is valid JSON). Otherwise the raw string is returned unchanged.
 *
 * @example
 * ```ts
 * const queryTool: LangChainGuardedTool = {
 *   name: "query_database",
 *   description: "Run a read-only SQL query and return results as JSON",
 *   schema: {
 *     type: "object",
 *     properties: { query: { type: "string" } },
 *     required: ["query"],
 *   },
 *   execute: async ({ query }) => JSON.stringify(await db.query(query)),
 * };
 * ```
 */
export interface LangChainGuardedTool<
  TInput extends Record<string, unknown> = Record<string, unknown>,
> {
  name: string;
  description: string;
  schema?: LangChainToolSchema;
  execute: (input: TInput) => Promise<string>;
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

export interface LangChainGuardOptions {
  /** Agent identifier (e.g. `"service:analytics-bot"`). */
  agent: Resolver<string>;
  /** Action name. Defaults to the tool's name. */
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
   * - `"tool-result"` — return a JSON-serialized `DenialResult` string
   *   so the LLM can adapt its behaviour.
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
   *
   * Recommended range: 1000–10 000 ms. Enterprise minimum sweep interval
   * is 5000 ms (PROD-D9); setting this below the sweep interval provides
   * no additional latency reduction.
   */
  permitRevalidationIntervalMs?: number;
}

/** Returned (as a JSON string) instead of throwing when `onDeny: "tool-result"`. */
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

// Extended client type — activates when atlasent-api ships GET /v1/permits/:id/valid.
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
    // Heartbeat is a no-op until atlasent-api ships the endpoint.
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

// ── withLangChainGuard ────────────────────────────────────────────────────────

/**
 * Wrap an array of {@link LangChainGuardedTool} definitions with AtlaSent
 * authorization. Returns a new array with the same tool metadata but
 * with `execute` replaced by an authorize-first version.
 *
 * Pass the wrapped `execute` to `DynamicStructuredTool`, `DynamicTool`,
 * or any other LangChain tool factory:
 *
 * @example
 * ```ts
 * import { DynamicStructuredTool } from "@langchain/core/tools";
 * import { z } from "zod";
 * import { withLangChainGuard } from "@atlasent/langchain";
 *
 * const defs = withLangChainGuard(
 *   [{ name: "query_db", description: "...", execute: async ({ sql }) => db.run(sql) }],
 *   atlasent,
 *   { agent: "service:analytics-bot", permitRevalidationIntervalMs: 5000 },
 * );
 *
 * const tools = defs.map((d) =>
 *   new DynamicStructuredTool({
 *     name: d.name,
 *     description: d.description,
 *     schema: z.object({ sql: z.string() }),
 *     func: d.execute,
 *   }),
 * );
 * ```
 */
export function withLangChainGuard<T extends LangChainGuardedTool>(
  tools: readonly T[],
  client: AtlaSentClient,
  options: LangChainGuardOptions,
): T[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async (input: Record<string, unknown>): Promise<string> => {
      const name = tool.name;
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

        // Annotate JSON string results with permit metadata.
        try {
          const parsed = JSON.parse(result) as unknown;
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            return JSON.stringify({
              ...(parsed as Record<string, unknown>),
              _atlasent_permit_id: evalResp.permitId,
              _atlasent_audit_hash: evalResp.auditHash,
            });
          }
        } catch {
          // Non-JSON or non-object result — return as-is.
        }
        return result;
      } catch (err) {
        if (err instanceof AtlaSentDeniedError) throw err;
        if (err instanceof PermitRevoked) throw err;
        if ((options.onDeny ?? "throw") === "tool-result") {
          return JSON.stringify({
            denied: true,
            decision: "error",
            evaluationId: "",
            reason: err instanceof Error ? err.message : String(err),
          } satisfies DenialResult);
        }
        throw err;
      }
    },
  })) as unknown as T[];
}

function handleDenial(
  onDeny: "throw" | "tool-result" | undefined,
  denial: DenialResult,
): string {
  if ((onDeny ?? "throw") === "tool-result") return JSON.stringify(denial);
  throw new AtlaSentDeniedError({
    decision: "deny",
    evaluationId: denial.evaluationId,
    reason: denial.reason,
    ...(denial.auditHash !== undefined ? { auditHash: denial.auditHash } : {}),
  });
}
