/**
 * AtlaSent authorization wrapper for Cursor agent tools.
 *
 * Cursor's background agent calls tools via the Model Context Protocol
 * (MCP) wire format: each tool has a flat `parameters` JSON Schema and
 * returns a string. This package wraps that shape with authorize-first
 * semantics without depending on any Cursor or MCP SDK:
 *
 *   1. evaluate     — check the policy engine
 *   2. verifyPermit — confirm the permit cryptographically
 *   3. execute      — run the tool only if both pass
 *
 * When `permitRevalidationIntervalMs` is set, the guard also runs a
 * continuous-authorization heartbeat (PROD-D9): it polls
 * `GET /v1/permits/:id/valid` at the configured interval and throws
 * `PermitRevoked` if the permit is revoked mid-execution.
 *
 * The returned objects are drop-in replacements for your existing tool
 * array: pass them to your Cursor MCP server's `ListToolsResult` and
 * call `execute` from your `CallToolResult` handler.
 */

import type { AtlaSentClient } from "@atlasent/sdk";
import { AtlaSentDeniedError, PermitRevoked } from "@atlasent/sdk";

// ── Cursor tool shape (MCP-compatible, duck-typed) ────────────────────────────

/** JSON Schema for a Cursor tool's input parameters. */
export interface CursorToolParameters {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

/**
 * A Cursor-style tool definition extended with an `execute` callback.
 * Cursor tools return strings (MCP `content[0].text` convention).
 *
 * @example
 * ```ts
 * const editFileTool: CursorGuardedTool = {
 *   name: "edit_file",
 *   description: "Apply a patch to a file in the workspace",
 *   parameters: {
 *     type: "object",
 *     properties: {
 *       path: { type: "string" },
 *       patch: { type: "string" },
 *     },
 *     required: ["path", "patch"],
 *   },
 *   execute: async ({ path, patch }) => applyPatch(path, patch),
 * };
 * ```
 */
export interface CursorGuardedTool<
  TInput extends Record<string, unknown> = Record<string, unknown>,
> {
  name: string;
  description: string;
  parameters?: CursorToolParameters;
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

export interface CursorGuardOptions {
  /** Agent identifier (e.g. `"cursor:my-project"`). */
  agent: Resolver<string>;
  /** Action name. Defaults to the tool's name. */
  action?: Resolver<string>;
  /** Extra context forwarded to every AtlaSent evaluation. */
  extraContext?: Resolver<Record<string, unknown>>;
  /**
   * - `"throw"` (default) — throw `AtlaSentDeniedError` on denial.
   * - `"tool-result"` — return a JSON-serialized `DenialResult` string
   *   so the agent can observe and adapt.
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

// ── withCursorGuard ───────────────────────────────────────────────────────────

/**
 * Wrap an array of {@link CursorGuardedTool} definitions with AtlaSent
 * authorization. Returns a new array with the same shape but `execute`
 * replaced by an authorize-first version.
 *
 * Successful string results are returned as-is (Cursor renders them
 * directly). JSON object results embedded in the string are unchanged
 * — Cursor's agent reads the raw string from MCP content blocks.
 *
 * @example
 * ```ts
 * import { withCursorGuard } from "@atlasent/cursor";
 *
 * const guardedTools = withCursorGuard(
 *   [editFileTool, runCommandTool],
 *   atlasent,
 *   { agent: "cursor:my-project", permitRevalidationIntervalMs: 5000 },
 * );
 *
 * // In your MCP server's CallToolRequestSchema handler:
 * const tool = guardedTools.find((t) => t.name === request.params.name);
 * const result = await tool.execute(request.params.arguments ?? {});
 * return { content: [{ type: "text", text: result }] };
 * ```
 */
export function withCursorGuard<T extends CursorGuardedTool>(
  tools: readonly T[],
  client: AtlaSentClient,
  options: CursorGuardOptions,
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
      const context = { ...extra, tool_input: input };
      const verifyEnvironment =
        typeof context.environment === "string"
          ? context.environment
          : typeof context.environment_name === "string"
            ? context.environment_name
            : undefined;

      try {
        const evalResp = await client.evaluate({ agent, action, context });

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

        // Append permit metadata when the result is a JSON object string.
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
          // Plain text or non-object JSON — return unchanged.
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
