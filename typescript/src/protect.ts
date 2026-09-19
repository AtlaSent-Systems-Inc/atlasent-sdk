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

import { AtlaSentClient, buildEvaluateBody } from "./client.js";
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
import type { LegacyEvaluateRequest, V2EvaluateRequest } from "./compat.js";
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
import {
  normalizeCallerPayloadHash,
  serverPayloadHash,
} from "./payloadHash.js";

/** Input to {@link protect}. Same shape as `EvaluateRequest`. */
export interface ProtectRequest {
  agent: string;
  action: string;
  context?: Record<string, unknown>;
  /**
   * SHA-256 digest of the payload this call will actually execute — the tool
   * arguments, the request body, the artifact bytes. Bare 64-char hex; a
   * `sha256:` prefix is accepted and stripped.
   *
   * Supplying it is what makes the permit constrain execution. It is sent as
   * a top-level `execution_payload_hash` on the evaluate request, which
   * `v1-evaluate` signs into the permit as `execution_hash_expected`, and is
   * re-presented at the verify boundary. A payload that changed between
   * authorization and execution then fails closed with `PAYLOAD_MISMATCH`
   * instead of running.
   *
   * Omit it and the permit is still bound — but only to the server's own hash
   * of this evaluate request, which `protect()` recomputes from the same
   * in-memory object microseconds later. That comparison is self-referential:
   * it cannot detect a substituted payload, because nothing re-derives the
   * digest from the thing about to execute. For an AI agent whose tool
   * arguments are attacker-influenceable, supply this.
   *
   * A malformed value THROWS rather than being forwarded — the runtime drops
   * one silently, which mints a permit that looks bound and is not.
   */
  executionPayloadHash?: string;
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
  const hasProcessEnv = typeof process !== "undefined" && !!process.env;
  const envApiKey = hasProcessEnv ? process.env.ATLASENT_API_KEY : undefined;
  const envBaseUrl = hasProcessEnv
    ? (process.env.ATLASENT_BASE_URL ?? process.env.ATLASENT_API_URL)
    : undefined;

  const apiKey = overrides.apiKey ?? envApiKey;
  if (!apiKey) {
    throw new AtlaSentError(
      "AtlaSent is not configured. Set ATLASENT_API_KEY in the environment, or call atlasent.configure({ apiKey }).",
      { code: "invalid_api_key" },
    );
  }
  const options: AtlaSentClientOptions = { apiKey };
  const baseUrl = overrides.baseUrl ?? envBaseUrl;
  if (baseUrl !== undefined) options.baseUrl = baseUrl;
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
 * Resolve the digest to present at the verify boundary, in the form
 * `v1-verify-permit` will actually compare it against.
 *
 * There are two bindings and the presented form must follow whichever one is
 * in force — the comparison folds case and normalizes nothing else, so the
 * right digest in the wrong form is a deterministic `PAYLOAD_MISMATCH`:
 *
 *   - Caller supplied `executionPayloadHash` -> `v1-evaluate` signed that bare
 *     lowercase hex into the permit as `execution_hash_expected`. Present it
 *     unchanged.
 *   - Caller supplied nothing -> the permit is bound to the server's own
 *     `sha256:`-prefixed hash of the whole evaluate request body. Reproduce it,
 *     prefix included.
 *
 * Presenting the un-prefixed mirror is not a hypothetical: it is what this
 * function replaced, and it denied every `protect()` /
 * `protectWithEvidence()` call against a runtime that populates the binding.
 * `test/protect-execution-binding.test.ts` pins the posted body for both
 * branches; `test/payload-hash-parity.test.ts` pins the digest itself against
 * the server's own canonicalization.
 *
 * `postedBody` must be the body that was ACTUALLY sent, from
 * {@link buildEvaluateBody} — never a second, hand-written reconstruction of
 * it. A field that reaches the wire without reaching the hash yields a digest
 * the server cannot match, and that is not hypothetical either: the Python
 * SDK's hand-written mirror omitted `state_snapshot`, so every
 * `protect(state_snapshot=...)` call was a guaranteed mismatch on its own.
 */
async function resolvePresentedPayloadHash(
  request: ProtectRequest,
  postedBody: Record<string, unknown>,
): Promise<string | undefined> {
  if (request.executionPayloadHash !== undefined) {
    // Already normalized (and validated) by the caller path below, but
    // normalizing again is free and keeps this function correct on its own.
    return normalizeCallerPayloadHash(request.executionPayloadHash);
  }

  // The server hashes the request body minus these three fields.
  const {
    traceparent: _traceparent,
    shadow: _shadow,
    explain: _explain,
    ...core
  } = postedBody;

  try {
    return await serverPayloadHash(core);
  } catch {
    // Neither crypto.subtle nor node:crypto is available (a very old Node, a
    // restricted runtime). Omit the field rather than throw, preserving the
    // long-standing behavior here: the server then requires it on a
    // production permit and denies with PAYLOAD_HASH_REQUIRED, which is
    // fail-closed. Warn, because a silently absent binding is the thing this
    // whole module exists to prevent.
    // eslint-disable-next-line no-console
    console.warn(
      "[atlasent] Could not compute the execution payload hash: neither " +
        "crypto.subtle nor node:crypto is available in this runtime. The " +
        "permit will not be verified against a payload binding, and a " +
        "production permit will be DENIED at verify.",
    );
    return undefined;
  }
}

/**
 * Map a {@link ProtectRequest} onto the evaluate request the client posts.
 *
 * Exists because the two shapes differ in more than case: `ProtectRequest`
 * spells the digest `executionPayloadHash`, the wire field is a TOP-LEVEL
 * `execution_payload_hash`, and the value must be bare lowercase hex before it
 * leaves here. Passing the `ProtectRequest` straight through — which this
 * module did — type-checks, drops the digest, and mints an unbound permit.
 *
 * Every OTHER property is forwarded untouched, by spread rather than by an
 * allowlist. That is deliberate and is behavior-preserving: `protect()`
 * previously handed its request object directly to `client.evaluate`, so any
 * evaluate field a caller set (`state_snapshot`, `resource`, `environment`, …)
 * reached the wire even though `ProtectRequest` does not declare it. An
 * allowlist here would silently stop forwarding those — the same class of
 * silent drop this whole change exists to remove. Caught by a precondition
 * assertion in `test/protect-execution-binding.test.ts` after a first version
 * of this function did exactly that.
 */
function toEvaluateRequest(
  request: ProtectRequest,
): LegacyEvaluateRequest & Pick<V2EvaluateRequest, "execution_payload_hash"> {
  const { agent, action, executionPayloadHash, ...rest } = request as ProtectRequest &
    Record<string, unknown>;

  const evaluateRequest = {
    ...rest,
    action,
    agent,
  } as LegacyEvaluateRequest & Pick<V2EvaluateRequest, "execution_payload_hash">;

  if (executionPayloadHash !== undefined) {
    evaluateRequest.execution_payload_hash =
      normalizeCallerPayloadHash(executionPayloadHash);
  }
  return evaluateRequest;
}

/**
 * Validate a caller-supplied digest up front, before any network call.
 *
 * Separate from {@link resolvePresentedPayloadHash} so the throw happens at
 * the top of the flow: forwarding a malformed digest would have the runtime
 * drop it silently and mint a permit bound to its own request hash instead —
 * indistinguishable, to the caller, from a real binding.
 */
function validateCallerPayloadHash(request: ProtectRequest): void {
  if (request.executionPayloadHash !== undefined) {
    normalizeCallerPayloadHash(request.executionPayloadHash);
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
  // Reject a malformed caller digest here, before any network call: the
  // runtime would DROP it silently and mint a permit bound to its own request
  // hash instead, which the caller cannot distinguish from a real binding.
  validateCallerPayloadHash(request);
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
  // One construction site, one input: `client.evaluate` builds its wire body
  // with buildEvaluateBody from this exact object, so hashing
  // buildEvaluateBody(evaluateRequest) below hashes the bytes that were
  // posted. Same pure function, same input — not a reconstruction that can
  // drift. See resolvePresentedPayloadHash.
  const evaluateRequest = toEvaluateRequest(request);
  const evaluation = await client.evaluate(evaluateRequest);

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

  // Resolve the digest to present at the boundary. Which form is correct
  // depends on which binding the permit carries — see
  // resolvePresentedPayloadHash.
  const execution_hash = await resolvePresentedPayloadHash(
    request,
    buildEvaluateBody(evaluateRequest),
  );

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
  // Reject a malformed caller digest here, before any network call: the
  // runtime would DROP it silently and mint a permit bound to its own request
  // hash instead, which the caller cannot distinguish from a real binding.
  validateCallerPayloadHash(request);
  const client = getClient();

  // 1. Evaluate (same logic as protect()).
  // One construction site, one input: `client.evaluate` builds its wire body
  // with buildEvaluateBody from this exact object, so hashing
  // buildEvaluateBody(evaluateRequest) below hashes the bytes that were
  // posted. Same pure function, same input — not a reconstruction that can
  // drift. See resolvePresentedPayloadHash.
  const evaluateRequest = toEvaluateRequest(request);
  const evaluation = await client.evaluate(evaluateRequest);

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

  // Resolve the digest to present at the boundary. Which form is correct
  // depends on which binding the permit carries — see
  // resolvePresentedPayloadHash.
  const execution_hash = await resolvePresentedPayloadHash(
    request,
    buildEvaluateBody(evaluateRequest),
  );

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
