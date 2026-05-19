/**
 * `atlasent.protect(...)` — the one-call, fail-closed execution-time
 * authorization boundary.
 *
 * ```ts
 * import atlasent from "@atlasent/sdk";
 *
 * const permit = await atlasent.protect({
 *   agent: "deploy-bot",
 *   action: "production.deploy",
 *   context: { commit, approver },
 * });
 * // …run the action. If we got here, AtlaSent authorized it
 * // end-to-end (evaluate + verifyPermit).
 * ```
 *
 * Unlike {@link AtlaSentClient.evaluate}, `protect` never returns a
 * denied decision. On deny, it throws {@link AtlaSentDeniedError};
 * on transport / auth / server failure it throws
 * {@link AtlaSentError}. The action cannot execute unless a valid
 * {@link Permit} is returned — this is the SDK's category boundary,
 * not a helper.
 */

import { AtlaSentClient } from "./client.js";
import type { DeployGateRequest, DeployGateResponse } from "./types.js";
import {
  AtlaSentDeniedError,
  AtlaSentError,
  normalizePermitOutcome,
  type AtlaSentDecision,
} from "./errors.js";
import type { AtlaSentClientOptions } from "./types.js";

/** Input to {@link protect}. Same shape as `EvaluateRequest`. */
export interface ProtectRequest {
  agent: string;
  action: string;
  context?: Record<string, unknown>;
}

/**
 * Success return from {@link protect}. The action is authorized
 * end-to-end — evaluation allowed AND the resulting permit verified.
 */
export interface Permit {
  /** Opaque permit / decision identifier. */
  permitId: string;
  /** Verification hash bound to the permit. */
  permitHash: string;
  /** Audit-trail entry associated with the decision (hash-chained). */
  auditHash: string;
  /** Human-readable reason from the policy engine. */
  reason: string;
  /** ISO 8601 timestamp of the verification. */
  timestamp: string;
}

/** Configuration for the process-wide singleton used by {@link protect}. */
export interface ConfigureOptions {
  /** Overrides `ATLASENT_API_KEY` env var. */
  apiKey?: string;
  /** Overrides the default `https://api.atlasent.io`. */
  baseUrl?: string;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Inject a custom fetch (primarily for tests). */
  fetch?: typeof fetch;
  /** Override the retry policy. Pass `{ maxAttempts: 1 }` to disable retries. */
  retryPolicy?: import("./retry.js").RetryPolicy;
}

let sharedClient: AtlaSentClient | null = null;
let overrides: ConfigureOptions = {};

/**
 * Configure the singleton client used by {@link protect}. Optional —
 * if `ATLASENT_API_KEY` is set in the environment, `protect` works
 * without any configuration. Calling `configure` again replaces the
 * singleton; subsequent `protect` calls use the new settings.
 */
export function configure(options: ConfigureOptions): void {
  overrides = { ...overrides, ...options };
  sharedClient = null;
}

/**
 * Run the canonical Deploy Gate V1 helper using the process-wide client.
 * Defaults to action `production.deploy`; execution is allowed only after
 * server-side `/v1-evaluate` and `/v1-verify-permit` both pass.
 */
export async function deployGate(
  request: DeployGateRequest = {},
): Promise<DeployGateResponse> {
  return getClient().deployGate(request);
}

/** Reset the singleton. Exported for tests; not part of the public API. */
export function __resetSharedClientForTests(): void {
  sharedClient = null;
  overrides = {};
}

function getClient(): AtlaSentClient {
  if (sharedClient) return sharedClient;

  // Guard process.env access so this module is safe in browser and
  // edge-runtime environments where `process` is not defined as a global.
  const envApiKey =
    typeof process !== "undefined" && process.env
      ? process.env.ATLASENT_API_KEY
      : undefined;

  const apiKey = overrides.apiKey ?? envApiKey;
  if (!apiKey) {
    throw new AtlaSentError(
      "AtlaSent is not configured. Set ATLASENT_API_KEY in the environment, or call atlasent.configure({ apiKey }).",
      { code: "invalid_api_key" },
    );
  }
  const options: AtlaSentClientOptions = { apiKey };
  if (overrides.baseUrl !== undefined) options.baseUrl = overrides.baseUrl;
  if (overrides.timeoutMs !== undefined)
    options.timeoutMs = overrides.timeoutMs;
  if (overrides.fetch !== undefined) options.fetch = overrides.fetch;
  if (overrides.retryPolicy !== undefined)
    options.retryPolicy = overrides.retryPolicy;
  sharedClient = new AtlaSentClient(options);
  return sharedClient;
}

function wireDecisionToDenied(serverDecision: string): AtlaSentDecision {
  // Normalise to lowercase before matching — the decision field is now
  // always lowercase from evaluate(), but defensive lower-casing here
  // handles any edge case where an older code path sends uppercase.
  const lower = serverDecision.toLowerCase();
  if (lower === "hold" || lower === "escalate") return lower;
  return "deny";
}

// ── Execution-hash helpers ────────────────────────────────────────────────────

/**
 * Sort all object keys recursively so the JSON serialization is
 * deterministic (RFC-8785-style canonical form). Arrays are preserved
 * in insertion order; only object keys are sorted.
 */
function sortKeysDeep(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(sortKeysDeep);
  if (val !== null && typeof val === "object") {
    return Object.keys(val as object)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortKeysDeep((val as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return val;
}

/**
 * Compute a SHA-256 hex digest of the recursively key-sorted canonical
 * JSON of `payload`. Used as `execution_hash` on the permit-consume
 * (verify) request so the server can validate the evaluate payload
 * was not tampered with between evaluate and consume.
 *
 * Falls back to `node:crypto` when `crypto.subtle` is unavailable
 * (Node < 20 without the Web Crypto global).
 */
async function computeExecutionHash(payload: unknown): Promise<string> {
  const sorted = sortKeysDeep(payload);
  const canonical = JSON.stringify(sorted);

  // Prefer the Web Crypto API (available in browsers, Node 20+,
  // Cloudflare Workers, Deno, etc.).
  if (
    typeof globalThis !== "undefined" &&
    globalThis.crypto?.subtle?.digest
  ) {
    const bytes = new TextEncoder().encode(canonical);
    const buf = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  // Fallback: node:crypto (Node < 20 or environments without crypto.subtle).
  try {
    // Dynamic import so bundlers that target browsers don't pull in
    // node internals. The `node:` prefix avoids any user-land shim.
    const { createHash } =
      await import(/* @vite-ignore */ /* webpackIgnore: true */ "node:crypto");
    return createHash("sha256").update(canonical, "utf8").digest("hex");
  } catch {
    // Last-resort: if neither crypto.subtle nor node:crypto is available
    // (very old Node, restricted runtime), return an empty string so the
    // verify call still proceeds — the server will reject if execution_hash
    // is required for production permits.
    // eslint-disable-next-line no-console
    console.warn(
      "[atlasent] Could not compute execution_hash: neither crypto.subtle " +
        "nor node:crypto is available in this runtime.",
    );
    return "";
  }
}

/**
 * Authorize an action end-to-end. On allow, returns a verified
 * {@link Permit}. On anything else, throws:
 *
 * - {@link AtlaSentDeniedError} — policy denied, or the permit
 *   failed verification. Fail-closed: if this throws, the action
 *   MUST NOT proceed.
 * - {@link AtlaSentError} — transport, timeout, auth, rate-limit,
 *   or server error. Same fail-closed contract: do not proceed.
 */
export async function protect(request: ProtectRequest): Promise<Permit> {
  const client = getClient();
  const evaluation = await client.evaluate(request);

  // decision is now canonical lowercase: "allow" | "deny" | "hold" | "escalate"
  if (evaluation.decision !== "allow") {
    throw new AtlaSentDeniedError({
      decision: wireDecisionToDenied(evaluation.decision),
      evaluationId: evaluation.permitId,
      reason: evaluation.reason,
      auditHash: evaluation.auditHash,
    });
  }

  // P1-1: Extract environment from the evaluate payload. Priority:
  //   context.environment → (no top-level environment on EvaluateRequest)
  //   → default "production" with a console warning.
  const environment =
    (request.context?.environment as string | undefined) ??
    (() => {
      // eslint-disable-next-line no-console
      console.warn(
        "[atlasent] environment not set on evaluate request — " +
          "defaulting to 'production'. Set context.environment explicitly to suppress.",
      );
      return "production";
    })();

  // P1-5: Compute execution_hash over the original evaluate payload so
  //   the server can validate integrity on permit consume.
  const evaluatePayload = {
    action_type: request.action,
    actor_id: request.agent,
    context: request.context ?? {},
  };
  const execution_hash = await computeExecutionHash(evaluatePayload);

  const verifyRequest: {
    permitId: string;
    agent: string;
    action: string;
    context?: Record<string, unknown>;
    environment: string;
    execution_hash?: string;
  } = {
    permitId: evaluation.permitId,
    agent: request.agent,
    action: request.action,
    environment,
    ...(execution_hash ? { execution_hash } : {}),
  };
  if (request.context !== undefined) verifyRequest.context = request.context;
  const verification = await client.verifyPermit(verifyRequest);

  if (!verification.verified) {
    const outcome = normalizePermitOutcome(verification.outcome);
    throw new AtlaSentDeniedError({
      decision: "deny",
      evaluationId: evaluation.permitId,
      reason: `Permit failed verification (${verification.outcome})`,
      auditHash: evaluation.auditHash,
      ...(outcome !== undefined && { outcome }),
    });
  }

  return {
    permitId: evaluation.permitId,
    permitHash: verification.permitHash,
    auditHash: evaluation.auditHash,
    reason: evaluation.reason,
    timestamp: verification.timestamp,
  };
}
