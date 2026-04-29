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
 * The returned objects are drop-in replacements for your existing tool
 * array: pass them to your Cursor MCP server's `ListToolsResult` and
 * call `execute` from your `CallToolResult` handler.
 */

import type { AtlaSentClient } from "@atlasent/sdk";
import { AtlaSentDeniedError } from "@atlasent/sdk";

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
}

/** Returned (as a JSON string) instead of throwing when `onDeny: "tool-result"`. */
export interface DenialResult {
  denied: true;
  decision: string;
  evaluationId: string;
  reason: string;
  auditHash?: string;
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
 *   { agent: "cursor:my-project" },
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

        // Append permit metadata as a JSON trailer the agent can parse.
        // The result string is returned intact; metadata is appended only
        // when the result is already a JSON object string so as not to
        // corrupt plain-text results.
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
