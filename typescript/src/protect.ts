/**
 * `atlasent.protect(...)` — the one-call, fail-closed execution-time
 * authorization boundary.
 *
 * ```ts
 * import atlasent from "@atlasent/sdk";
 *
 * const permit = await atlasent.protect({
 *   agent: "deploy-bot",
 *   action: "deploy_to_production",
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
import {
  AtlaSentDeniedError,
  AtlaSentError,
  type AtlaSentDecision,
} from "./errors.js";
import type { AtlaSentClientOptions, OnRetryContext, RetryPolicy } from "./types.js";

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
  /** Retry policy override. Pass `{ maxAttempts: 1 }` to disable retries. */
  retryPolicy?: RetryPolicy;
  /** Called before each retry sleep. */
  onRetry?: (ctx: OnRetryContext) => void;
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

/** Reset the singleton. Exported for tests; not part of the public API. */
export function __resetSharedClientForTests(): void {
  sharedClient = null;
  overrides = {};
}

function getClient(): AtlaSentClient {
  if (sharedClient) return sharedClient;

  const apiKey = overrides.apiKey ?? process.env.ATLASENT_API_KEY;
  if (!apiKey) {
    throw new AtlaSentError(
      "AtlaSent is not configured. Set ATLASENT_API_KEY in the environment, or call atlasent.configure({ apiKey }).",
      { code: "invalid_api_key" },
    );
  }
  const options: AtlaSentClientOptions = { apiKey };
  if (overrides.baseUrl !== undefined) options.baseUrl = overrides.baseUrl;
  if (overrides.timeoutMs !== undefined) options.timeoutMs = overrides.timeoutMs;
  if (overrides.fetch !== undefined) options.fetch = overrides.fetch;
  if (overrides.retryPolicy !== undefined) options.retryPolicy = overrides.retryPolicy;
  if (overrides.onRetry !== undefined) options.onRetry = overrides.onRetry;
  sharedClient = new AtlaSentClient(options);
  return sharedClient;
}

function wireDecisionToDenied(serverDecision: string): AtlaSentDecision {
  // The current /v1-evaluate contract returns "ALLOW" | "DENY". Map
  // "DENY" → "deny"; any future lowercase-or-new value passes through
  // so forthcoming "hold" / "escalate" responses don't break callers.
  const lower = serverDecision.toLowerCase();
  if (lower === "hold" || lower === "escalate") return lower;
  return "deny";
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

  if (evaluation.decision !== "ALLOW") {
    throw new AtlaSentDeniedError({
      decision: wireDecisionToDenied(evaluation.decision),
      evaluationId: evaluation.permitId,
      reason: evaluation.reason,
      auditHash: evaluation.auditHash,
    });
  }

  const verifyRequest: {
    permitId: string;
    agent: string;
    action: string;
    context?: Record<string, unknown>;
  } = {
    permitId: evaluation.permitId,
    agent: request.agent,
    action: request.action,
  };
  if (request.context !== undefined) verifyRequest.context = request.context;
  const verification = await client.verifyPermit(verifyRequest);

  if (!verification.verified) {
    throw new AtlaSentDeniedError({
      decision: "deny",
      evaluationId: evaluation.permitId,
      reason: `Permit failed verification (${verification.outcome})`,
      auditHash: evaluation.auditHash,
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
