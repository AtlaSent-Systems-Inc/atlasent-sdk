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
 *
 * `protectWithEvidence` is the same contract plus a signed
 * {@link DecisionReceipt} minted on the way out. Use it when you need
 * tamper-evident proof of authorization stored alongside the action
 * record (deploy logs, payment records, close workflows).
 */

import { AtlaSentClient } from "./client.js";
import type { DeployGateRequest, DeployGateResponse } from "./types.js";
import {
  AtlaSentDeniedError,
  AtlaSentError,
  BundleVerificationError,
  normalizePermitOutcome,
  type AtlaSentDecision,
} from "./errors.js";
import { getGlobalTrustRootManager } from "./trustRoot.js";
import type { AtlaSentClientOptions, ConstraintTrace } from "./types.js";
import {
  buildDecisionReceiptPayload,
  buildWhyTrace,
  computeContextHash,
  signDecisionReceiptHmac,
} from "./evidenceEngine.js";
import type {
  DecisionReceipt,
  DecisionReceiptAlgorithm,
} from "./evidenceEngine.js";

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
  /** ISO-8601 expiration timestamp of the permit. null on pre-rollout servers. */
  permitExpiresAt: string | null;
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

// Mirrors the server-side ACTION_TYPE_RE in v1-evaluate/handler.ts.
const ACTION_TYPE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

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

function generateReceiptId(): string {
  if (
    typeof globalThis !== "undefined" &&
    typeof globalThis.crypto?.randomUUID === "function"
  ) {
    return globalThis.crypto.randomUUID();
  }
  return `rcpt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
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
  if (!ACTION_TYPE_RE.test(request.action)) {
    throw new AtlaSentError(
      `action must be in dot-notation format (e.g. "production.deploy"). Got: ${JSON.stringify(request.action)}`,
      { code: "bad_request" },
    );
  }
  // ADR-005 D3: fail-closed on expired trust snapshot. checkExpiry() also
  // emits the one-time half-life warning if >50% of validity window has elapsed.
  const trustMgr = getGlobalTrustRootManager({ disableRefresh: false });
  if (trustMgr.checkExpiry() === "expired") {
    const snap = trustMgr.getSnapshot();
    throw new BundleVerificationError({
      reason: "trust_snapshot_expired",
      snapshotValidUntil: snap.valid_until,
      snapshotFetchedAt: snap.issued_at,
    });
  }
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

  const environment = request.context?.environment as string | undefined;
  if (!environment) {
    throw new AtlaSentError(
      'context.environment is required. Pass the environment where this action executes (e.g. "production", "staging").',
      { code: "bad_request" },
    );
  }

  // Compute execution_hash over the original evaluate payload so
  // the server can validate integrity on permit consume.
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
    permitExpiresAt: verification.expiresAt ?? null,
  };
}

// ── Evidence-enhanced protect ─────────────────────────────────────────────────

/**
 * A verified {@link Permit} with an embedded signed {@link DecisionReceipt}.
 *
 * Returned by {@link protectWithEvidence}. Store `receipt` alongside
 * your action record (deploy logs, payment records, close workflows)
 * to give auditors a self-contained proof of authorization.
 */
export interface PermitWithEvidence extends Permit {
  /** Signed per-decision receipt. `algorithm: "none"` when no signing secret was supplied. */
  receipt: DecisionReceipt;
}

/** Options for {@link protectWithEvidence}. */
export interface ProtectWithEvidenceOptions {
  /**
   * HMAC-SHA256 signing secret. When provided, the receipt is signed
   * and can be verified offline with `verifyDecisionReceiptHmac`.
   * Recommend `process.env.ATLASENT_RECEIPT_SIGNING_SECRET`.
   */
  signingSecret?: string;
  /**
   * Registry key ID recorded on the receipt, paired with `signingSecret`.
   * Used for key rotation: store the ID alongside the receipt so
   * verifiers know which key to use.
   */
  signingKeyId?: string;
  /**
   * If you have already called `client.evaluatePreflight()` for this
   * request, pass `constraintTrace` here to populate
   * `receipt.why_trace` with the full stage-by-stage "why" trace.
   * When omitted, `why_trace` is `null` on the receipt.
   */
  constraintTrace?: ConstraintTrace | null;
}

/**
 * Authorize an action end-to-end and mint a signed {@link DecisionReceipt}.
 *
 * Same fail-closed contract as {@link protect} — throws
 * {@link AtlaSentDeniedError} on deny, {@link AtlaSentError} on
 * transport failure. The action MUST NOT proceed if this throws.
 *
 * On allow, returns the verified `Permit` plus a signed `DecisionReceipt`
 * that captures:
 * - The evaluation ID and decision
 * - Human-readable reasons
 * - Permit ID and hash
 * - Audit-trail hash (hash-chain link)
 * - SHA-256 of the evaluate context (tamper-evidence for the inputs)
 * - Optional "why" trace (pass `constraintTrace` from `evaluatePreflight`)
 *
 * ```ts
 * const { permit, receipt } = await protectWithEvidence(
 *   { agent: "deploy-bot", action: "production.deploy", context },
 *   {
 *     signingSecret: process.env.ATLASENT_RECEIPT_SIGNING_SECRET,
 *     signingKeyId: "key-v1",
 *   },
 * );
 * // Store alongside the deployment record.
 * await db.deployments.create({ commitSha, permit, receipt });
 * ```
 */
export async function protectWithEvidence(
  request: ProtectRequest,
  opts: ProtectWithEvidenceOptions = {},
): Promise<PermitWithEvidence> {
  if (!ACTION_TYPE_RE.test(request.action)) {
    throw new AtlaSentError(
      `action must be in dot-notation format (e.g. "production.deploy"). Got: ${JSON.stringify(request.action)}`,
      { code: "bad_request" },
    );
  }
  const client = getClient();

  // 1. Evaluate (same logic as protect()).
  const evaluation = await client.evaluate(request);

  if (evaluation.decision !== "allow") {
    throw new AtlaSentDeniedError({
      decision: wireDecisionToDenied(evaluation.decision),
      evaluationId: evaluation.permitId,
      reason: evaluation.reason,
      auditHash: evaluation.auditHash,
    });
  }

  // 2. Extract environment, compute execution_hash, verify permit.
  const environment = request.context?.environment as string | undefined;
  if (!environment) {
    throw new AtlaSentError(
      'context.environment is required. Pass the environment where this action executes (e.g. "production", "staging").',
      { code: "bad_request" },
    );
  }

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

  // 3. Build the receipt.
  const contextHash = await computeContextHash(request.context ?? {});

  const whyTrace = buildWhyTrace(
    "allow",
    evaluation.reasons,
    opts.constraintTrace ?? null,
  );

  const issuedAt = new Date().toISOString();
  const receiptId = generateReceiptId();
  const orgId = evaluation.permit?.orgId ?? "";

  const payload = buildDecisionReceiptPayload({
    receipt_id: receiptId,
    evaluation_id: evaluation.evaluationId,
    org_id: orgId,
    decision: "allow",
    action: request.action,
    actor: request.agent,
    resource_type:
      (request.context?.resource_type as string | undefined) ?? null,
    resource_id:
      (request.context?.resource_id as string | undefined) ?? null,
    reasons: evaluation.reasons,
    why_summary: whyTrace.summary,
    permit_id: evaluation.permitId,
    permit_hash: verification.permitHash,
    audit_hash: evaluation.auditHash,
    context_hash: contextHash,
    issued_at: issuedAt,
  });

  // 4. Sign if secret is provided.
  let signature: string | null = null;
  let algorithm: DecisionReceiptAlgorithm = "none";

  if (opts.signingSecret) {
    signature = await signDecisionReceiptHmac(payload, opts.signingSecret);
    algorithm = "hmac-sha256";
  }

  const receipt: DecisionReceipt = {
    receipt_id: receiptId,
    evaluation_id: evaluation.evaluationId,
    org_id: orgId,
    decision: "allow",
    action: request.action,
    actor: request.agent,
    resource_type:
      (request.context?.resource_type as string | undefined) ?? null,
    resource_id:
      (request.context?.resource_id as string | undefined) ?? null,
    reasons: evaluation.reasons,
    why_trace:
      opts.constraintTrace !== undefined ? whyTrace : null,
    permit_id: evaluation.permitId,
    permit_hash: verification.permitHash,
    audit_hash: evaluation.auditHash,
    context_hash: contextHash,
    issued_at: issuedAt,
    expires_at: null,
    algorithm,
    signature,
    signing_key_id: opts.signingKeyId ?? null,
    payload,
  };

  return {
    permitId: evaluation.permitId,
    permitHash: verification.permitHash,
    auditHash: evaluation.auditHash,
    reason: evaluation.reason,
    timestamp: verification.timestamp,
    permitExpiresAt: verification.expiresAt ?? null,
    receipt,
  };
}
