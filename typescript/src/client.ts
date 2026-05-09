/**
 * AtlaSent HTTP client.
 *
 * Two public methods, both backed by native `fetch`:
 *   - {@link AtlaSentClient.evaluate}     → POST {baseUrl}/v1-evaluate
 *   - {@link AtlaSentClient.verifyPermit} → POST {baseUrl}/v1-verify-permit
 *
 * Fail-closed: a clean policy DENY is returned (not thrown), but
 * network, timeout, bad response, 4xx/5xx, and rate-limit conditions
 * all throw {@link AtlaSentError}.
 */

import type {
  AuditEventsPage,
  AuditEventsQuery,
  AuditExport,
} from "./audit.js";
import {
  AtlaSentError,
  StreamParseError,
  StreamTimeoutError,
  type AtlaSentErrorCode,
  type AtlaSentErrorInit,
} from "./errors.js";
import type {
  ApiKeySelfResponse,
  AtlaSentClientOptions,
  AuditEventsResult,
  AuditExportRequest,
  AuditExportResult,
  ConstraintTrace,
  EvaluatePreflightResponse,
  EvaluateRequest,
  EvaluateResponse,
  GetPermitResponse,
  ListPermitsRequest,
  ListPermitsResponse,
  PermitRecord,
  RateLimitState,
  RevokePermitByIdInput,
  RevokePermitByIdResponse,
  RevokePermitRequest,
  RevokePermitResponse,
  StreamDecisionEvent,
  StreamEvent,
  StreamOptions,
  StreamProgressEvent,
  VerifyPermitByIdResponse,
  VerifyPermitRequest,
  VerifyPermitResponse,
} from "./types.js";
import {
  normalizeEvaluateRequest,
  type LegacyEvaluateRequest,
  type V2EvaluateRequest,
} from "./compat.js";
import {
  computeBackoffMs,
  hasAttemptsLeft,
  isRetryable,
  mergePolicy,
  type RetryPolicy,
} from "./retry.js";
import type {
  HitlApprovalRecord,
  HitlApproveRequest,
  HitlChainHop,
  HitlEscalateRequest,
  HitlEscalation,
  HitlRejectRequest,
  ListHitlEscalationsRequest,
  ListHitlEscalationsResponse,
} from "./hitl.js";
import type {
  GovernanceGraphQueryType,
  GovernanceGraphQueryParams,
  GovernanceGraphQueryResponse,
  GovernanceGraphResultRow,
} from "./governanceGraph.js";
import type { IncidentTimelineResponse } from "./incidentReconstruction.js";
import type {
  ConnectorType,
  InstallConnectorInput,
  AuthenticateConnectorInput,
  UpsertEnforcementPolicyInput,
  ListConnectorsResponse,
  InstallConnectorResponse,
  AuthenticateConnectorResponse,
  SyncConnectorResponse,
  RevokeConnectorResponse,
  RotateCredentialsResponse,
  ListEnforcementPoliciesResponse,
  UpsertEnforcementPolicyResponse,
} from "./connectorManagement.js";
import type {
  ComputeOrgRiskOptions,
  ComputeOrgRiskResponse,
  GetLatestOrgRiskResponse,
  ListOrgRiskHistoryResponse,
} from "./orgRiskGraph.js";
import type {
  CrossOrgPermissionCheckRequest,
  CrossOrgPermissionCheckResult,
  CrossOrgPermissionCheckListParams,
} from "./crossOrgPermission.js";
import type {
  AnomalyResponseRule,
  AnomalyResponseEvent,
  CreateAnomalyResponseRuleRequest,
  TriggerAnomalyResponseRequest,
} from "./anomalyResponse.js";
import type {
  BudgetExceptionRequest,
  BudgetExceptionStatus,
  CreateBudgetExceptionRequest,
  ApproveBudgetExceptionRequest,
} from "./budgetExceptions.js";
import type {
  RegulatoryAuthorityLevel,
  RegulatoryEscalation,
  RegulatoryEscalationStatus,
  CreateRegulatoryEscalationRequest,
} from "./regulatoryEscalation.js";
import type {
  GovernanceSignalAction,
  RecordSignalActionRequest,
  RecordSignalOutcomeRequest,
  SignalActionSummary,
} from "./incentiveSignalFeedback.js";
import type {
  CrossOrgImpersonationGrant,
  CreateImpersonationGrantRequest,
  ImpersonationToken,
  ImpersonationValidationResult,
} from "./crossOrgImpersonation.js";

const DEFAULT_BASE_URL = "https://api.atlasent.io";
const DEFAULT_TIMEOUT_MS = 10_000;
const SDK_VERSION = "2.2.0";

function _buildUserAgent(): string {
  const isNode =
    typeof process !== "undefined" &&
    typeof process?.versions?.node === "string";
  return isNode
    ? `@atlasent/sdk/${SDK_VERSION} node/${process.version}`
    : `@atlasent/sdk/${SDK_VERSION} browser`;
}

// Soft cap on top-level context properties. Mirrors the Python SDK
// (atlasent.models._CONTEXT_PROPERTIES_SOFT_CAP) and the OpenAPI
// `maxProperties: 64` declaration. The hosted API is the canonical
// enforcer; this helper warns the developer in dev rather than
// raising, so production traffic isn't broken on the day this ships.
const CONTEXT_PROPERTIES_SOFT_CAP = 64;

function _warnOversizeContext(context: Record<string, unknown> | undefined): void {
  if (context && Object.keys(context).length > CONTEXT_PROPERTIES_SOFT_CAP) {
    // eslint-disable-next-line no-console
    console.warn(
      `[atlasent] context has ${Object.keys(context).length} top-level keys ` +
        `(soft cap ${CONTEXT_PROPERTIES_SOFT_CAP}); the server may reject this. ` +
        "Pack richer payloads under a single top-level key.",
    );
  }
}

/**
 * Reject non-TLS base URLs unless the dev escape hatch is set.
 *
 * `ATLASENT_ALLOW_INSECURE_HTTP=1` (Node) or
 * `globalThis.ATLASENT_ALLOW_INSECURE_HTTP === "1"` (browser dev) permits
 * `http://` for local fixtures — production callers never set this.
 * Non-`http(s)` schemes (data:, file:, ...) are rejected unconditionally.
 *
 * Guards `process.env` access with an explicit `typeof` check so this
 * function is safe in browser and edge-runtime environments where
 * `process` is not defined as a global.
 */
function _enforceTls(baseUrl: string): string {
  const nodeEnvValue =
    typeof process !== "undefined" && process.env
      ? process.env.ATLASENT_ALLOW_INSECURE_HTTP
      : undefined;
  const allow =
    nodeEnvValue === "1" ||
    (globalThis as { ATLASENT_ALLOW_INSECURE_HTTP?: string })
      .ATLASENT_ALLOW_INSECURE_HTTP === "1";
  if (allow) return baseUrl;
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new AtlaSentError(`Invalid baseUrl: ${baseUrl}`, {
      code: "bad_request",
    });
  }
  if (parsed.protocol !== "https:") {
    throw new AtlaSentError(
      `AtlaSent baseUrl must use https:// (got ${parsed.protocol}). ` +
        `For local development, set ATLASENT_ALLOW_INSECURE_HTTP=1.`,
      { code: "bad_request" },
    );
  }
  return baseUrl;
}

// API-key prefix contract per atlasent-api/_shared/auth.ts:
//   "ask_live_<entropy>" — production
//   "ask_test_<entropy>" — non-production
// Validated client-side so a mis-pasted key (with whitespace, quotes,
// or a leftover wrapping char) trips loudly at construction rather
// than yielding a 401 mid-conversation.
const API_KEY_PATTERN = /^ask_(?:live|test)_[A-Za-z0-9_-]+$/;

function _validateApiKey(apiKey: string): string {
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new AtlaSentError("apiKey is required", { code: "invalid_api_key" });
  }
  if (!API_KEY_PATTERN.test(apiKey)) {
    const head = apiKey.slice(0, 8);
    throw new AtlaSentError(
      `AtlaSent apiKey does not match expected shape ` +
        `\`ask_(live|test)_<entropy>\` (got prefix=${JSON.stringify(head)}). ` +
        "Check for whitespace, quotes, or trailing characters.",
      { code: "invalid_api_key" },
    );
  }
  return apiKey;
}

/**
 * True when running in Node.js (or a Node-compatible server runtime that
 * exposes `process.versions.node`). False in browsers and browser-like
 * environments such as jsdom / Cloudflare Workers.
 */
const isNode =
  typeof process !== "undefined" && typeof process.versions?.node === "string";

/**
 * Node.js version string captured at module-load time so request code
 * never accesses `process` lazily — safe even if `process` is absent
 * (browsers) or replaced after load (bundlers, test environments).
 * `null` in every non-Node runtime.
 */
const NODE_VERSION: string | null = isNode ? process.version : null;

/**
 * Raw JSON shape received from `POST /v1-evaluate`.
 *
 * Canonical fields (per `atlasent-api/.../v1-evaluate/handler.ts`):
 *   decision: "allow" | "deny" | "hold" | "escalate"
 *   permit_token: string  (present iff decision === "allow")
 *   request_id: string
 *   expires_at?: string
 *   denial?: { reason, code }
 *
 * Legacy fields kept on the type so older atlasent-api deployments
 * (pre-handler.ts entry swap) still parse cleanly. The client below
 * checks canonical first and falls back to legacy.
 */
interface EvaluateWire {
  decision: "allow" | "deny" | "hold" | "escalate";
  permit_token?: string;
  request_id?: string;
  expires_at?: string;
  denial?: { reason?: string; code?: string };
  /**
   * Optional sub-object — present iff the request URL carried
   * `?include=constraint_trace`. Older atlasent-api deployments
   * omit this even when `include` was requested; the preflight
   * helper degrades to `null` in that case.
   */
  constraint_trace?: unknown;
  // Legacy passthrough.
  permitted?: boolean;
  decision_id?: string;
  reason?: string;
  audit_hash?: string;
  timestamp?: string;
}

/** Raw JSON shape received from `GET /v1-api-key-self`. */
interface ApiKeySelfWire {
  key_id: string;
  organization_id: string;
  environment: string;
  scopes?: string[];
  allowed_cidrs?: string[] | null;
  rate_limit_per_minute: number;
  client_ip?: string | null;
  expires_at?: string | null;
}

/**
 * Raw JSON shape received from `POST /v1-verify-permit`.
 *
 * Canonical fields:
 *   valid: boolean
 *   outcome: "allow" | "deny"
 *   verify_error_code?: string  (populated on outcome === "deny")
 *   reason?: string
 *
 * Legacy `verified` kept for backward-compat with older deployments.
 */
interface VerifyPermitWire {
  valid: boolean;
  outcome: "allow" | "deny";
  verify_error_code?: string;
  reason?: string;
  // Legacy passthrough.
  verified?: boolean;
  permit_hash?: string;
  timestamp?: string;
}

export class AtlaSentClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly retryPolicy: Required<RetryPolicy>;

  constructor(options: AtlaSentClientOptions) {
    if (!options.apiKey || typeof options.apiKey !== "string") {
      throw new AtlaSentError("apiKey is required", {
        code: "invalid_api_key",
      });
    }
    if (typeof AbortSignal.timeout !== "function") {
      throw new AtlaSentError(
        "@atlasent/sdk requires AbortSignal.timeout, which is not available in this runtime. " +
          "Minimum supported browsers: Chrome 103+, Firefox 100+, Safari 16+. " +
          "Upgrade your browser or add an AbortSignal.timeout polyfill.",
        { code: "network" },
      );
    }
    this.apiKey = _validateApiKey(options.apiKey);
    this.baseUrl = _enforceTls(options.baseUrl ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      "",
    );
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.userAgent = _buildUserAgent();
    this.retryPolicy = mergePolicy(options.retryPolicy ?? {});
  }

  /**
   * Ask the policy engine whether an agent action is permitted.
   *
   * Accepts either the current v2.0 shape (`action_type` / `actor_id`)
   * or the legacy v1.x shape (`action` / `agent`). Legacy callers
   * receive a deprecation warning via `console.warn`; the shim is
   * handled by {@link normalizeEvaluateRequest} and will be removed
   * in v3.0.0.
   *
   * A "deny" is **not** thrown — it is returned in
   * `response.decision`. Network errors, invalid API key, rate
   * limits, timeouts, and malformed responses throw
   * {@link AtlaSentError}.
   */
  async evaluate(
    input: EvaluateRequest | LegacyEvaluateRequest,
  ): Promise<EvaluateResponse> {
    _warnOversizeContext(input.context);

    // Run the dual-shape bridge: legacy {action, agent} → {action_type, actor_id}.
    // For callers already on the current EvaluateRequest shape the bridge is a
    // transparent pass-through (no warn, no allocation).
    const normalized = normalizeEvaluateRequest(
      input as LegacyEvaluateRequest | V2EvaluateRequest,
    );

    const body = {
      action_type: normalized.action_type,
      actor_id: normalized.actor_id,
      context: normalized.context ?? {},
    };
    const { body: wire, rateLimit } = await this.post<EvaluateWire>("/v1-evaluate", body);

    // Normalise decision to lowercase canonical form. API responses may
    // arrive as uppercase (legacy deployments) or lowercase (canonical);
    // we always emit lowercase so callers can rely on a stable vocabulary.
    let decision = (typeof wire.decision === "string"
      ? wire.decision.toLowerCase()
      : wire.decision) as EvaluateWire["decision"] | undefined;

    // Tolerate both canonical {decision, permit_token} and legacy
    // {permitted, decision_id} server responses.
    if (decision === undefined && typeof wire.permitted === "boolean") {
      decision = wire.permitted ? "allow" : "deny";
    }
    const permitToken = wire.permit_token ?? wire.decision_id;

    if (decision !== "allow" && decision !== "deny" && decision !== "hold" && decision !== "escalate") {
      throw new AtlaSentError(
        "Malformed response from /v1-evaluate: missing `decision` (or legacy `permitted`)",
        { code: "bad_response" },
      );
    }
    if (decision === "allow" && (typeof permitToken !== "string" || permitToken.length === 0)) {
      throw new AtlaSentError(
        "Malformed response from /v1-evaluate: decision='allow' but no `permit_token` (or legacy `decision_id`)",
        { code: "bad_response" },
      );
    }

    return {
      decision,
      decision_canonical: decision,
      permitId: permitToken ?? "",
      reason: wire.denial?.reason ?? wire.reason ?? "",
      auditHash: wire.audit_hash ?? "",
      timestamp: wire.timestamp ?? "",
      rateLimit,
    };
  }

  /**
   * Pre-flight evaluation that always returns the constraint trace.
   *
   * Wraps `POST /v1-evaluate?include=constraint_trace`. Use this from
   * a workflow's submission step to surface trivial defects (missing
   * fields, wrong roles, mis-set context) BEFORE pushing the request
   * onto an approval queue — only requests that would actually pass
   * make it through to a human reviewer.
   *
   * Returns an {@link EvaluatePreflightResponse} carrying the regular
   * {@link EvaluateResponse} plus the {@link ConstraintTrace}. Unlike
   * {@link evaluate}, this method does NOT mark a non-allow as a
   * thrown condition — the whole point is to inspect both the outcome
   * AND the per-policy trace, so the caller branches on
   * `result.evaluation.decision` and reads `result.constraintTrace`
   * to render the failing stages.
   *
   * The constraint-trace shape mirrors `ConstraintTraceResponse` in
   * atlasent-api (`packages/types/src/index.ts`). On older
   * atlasent-api deployments that omit the trace, `constraintTrace`
   * is `null` rather than throwing — forward-compatible degradation.
   *
   * Performance: one extra round-trip on submission. Latency is
   * comparable to {@link evaluate}; the response body is fuller
   * (includes the per-stage trace) so the wire payload is larger.
   * If the caller does not need the trace, prefer {@link evaluate}.
   */
  async evaluatePreflight(
    input: EvaluateRequest,
  ): Promise<EvaluatePreflightResponse> {
    _warnOversizeContext(input.context);
    const body = {
      action_type: input.action,
      actor_id: input.agent,
      context: input.context ?? {},
    };
    const query = new URLSearchParams({ include: "constraint_trace" });
    const { body: wire, rateLimit } = await this.post<EvaluateWire>(
      "/v1-evaluate",
      body,
      query,
    );

    // Normalise decision to lowercase canonical form.
    let decision = (typeof wire.decision === "string"
      ? wire.decision.toLowerCase()
      : wire.decision) as EvaluateWire["decision"] | undefined;

    if (decision === undefined && typeof wire.permitted === "boolean") {
      decision = wire.permitted ? "allow" : "deny";
    }
    if (
      decision !== "allow" &&
      decision !== "deny" &&
      decision !== "hold" &&
      decision !== "escalate"
    ) {
      throw new AtlaSentError(
        "Malformed response from /v1-evaluate: missing `decision` (or legacy `permitted`)",
        { code: "bad_response" },
      );
    }
    const permitToken = wire.permit_token ?? wire.decision_id;

    const evaluation: EvaluateResponse = {
      decision,
      decision_canonical: decision,
      permitId: permitToken ?? "",
      reason: wire.denial?.reason ?? wire.reason ?? "",
      auditHash: wire.audit_hash ?? "",
      timestamp: wire.timestamp ?? "",
      rateLimit,
    };

    // Forward-compat: if the server omits `constraint_trace` (older
    // atlasent-api version), surface trace=null rather than throwing.
    // Unknown engine-side keys inside the trace are tolerated by the
    // ConstraintTrace interface's index signature.
    let constraintTrace: ConstraintTrace | null = null;
    if (
      wire.constraint_trace !== undefined &&
      wire.constraint_trace !== null &&
      typeof wire.constraint_trace === "object"
    ) {
      constraintTrace = wire.constraint_trace as ConstraintTrace;
    }

    return { evaluation, constraintTrace };
  }

  /**
   * Verify that a previously issued permit is still valid.
   *
   * @deprecated Use {@link verifyPermitById} — the canonical REST
   * surface (`POST /v1/permits/{id}/verify`) returns the unified
   * verification envelope plus the full {@link PermitRecord}, instead
   * of the legacy `{verified, outcome, permitHash}` shape this method
   * emits. Will be removed in `@atlasent/sdk@3`.
   *
   * A `verified: false` response is **not** thrown — inspect the
   * returned object. Only transport / server errors throw.
   */
  async verifyPermit(
    input: VerifyPermitRequest,
  ): Promise<VerifyPermitResponse> {
    _warnOversizeContext(input.context);
    // Canonical wire shape per handler.ts: only permit_token is required.
    // action_type / actor_id are optional cross-checks; context / api_key
    // are NOT consulted by the verify handler.
    const body = {
      permit_token: input.permitId,
      action_type: input.action ?? "",
      actor_id: input.agent ?? "",
    };
    const { body: wire, rateLimit } = await this.post<VerifyPermitWire>(
      "/v1-verify-permit",
      body,
    );

    // Tolerate both canonical {valid, outcome} and legacy {verified} server
    // responses.
    const valid = typeof wire.valid === "boolean" ? wire.valid : wire.verified;
    if (typeof valid !== "boolean") {
      throw new AtlaSentError(
        "Malformed response from /v1-verify-permit: missing `valid` (or legacy `verified`)",
        { code: "bad_response" },
      );
    }

    return {
      verified: valid,
      outcome: wire.outcome ?? "",
      permitHash: wire.permit_hash ?? "",
      timestamp: wire.timestamp ?? "",
      rateLimit,
    };
  }

  /**
   * Revoke a previously-issued permit so it can no longer pass
   * {@link verifyPermit}.
   *
   * @deprecated Use {@link revokePermitById} — the canonical REST
   * surface (`POST /v1/permits/{id}/revoke`) returns the full updated
   * {@link PermitRecord} with `revoked_at`/`revoked_by`/`revoke_reason`
   * populated, instead of the legacy `{revoked, permitId}` envelope
   * this method emits. Will be removed in `@atlasent/sdk@3`.
   *
   * Use this when an agent's action is cancelled, superseded, or
   * determined to be unauthorized after the fact. The revocation is
   * recorded in the audit log with the optional `reason`.
   *
   * Throws {@link AtlaSentError} on transport / auth failures.
   */
  async revokePermit(input: RevokePermitRequest): Promise<RevokePermitResponse> {
    const body = {
      decision_id: input.permitId,
      reason: input.reason ?? "",
      api_key: this.apiKey,
    };
    const { body: wire, rateLimit } = await this.post<{
      revoked: boolean;
      decision_id: string;
      revoked_at?: string;
      audit_hash?: string;
    }>("/v1-revoke-permit", body);

    if (typeof wire.revoked !== "boolean" || typeof wire.decision_id !== "string") {
      throw new AtlaSentError(
        "Malformed response from /v1-revoke-permit: missing `revoked` or `decision_id`",
        { code: "bad_response" },
      );
    }

    return {
      revoked: wire.revoked,
      permitId: wire.decision_id,
      revokedAt: wire.revoked_at,
      auditHash: wire.audit_hash,
      rateLimit,
    };
  }

  /**
   * Revoke a permit through the canonical REST surface
   * (`POST /v1/permits/{permitId}/revoke`).
   *
   * Returns the full updated {@link PermitRecord} with `status === 'revoked'`
   * and `revoked_at` / `revoked_by` / `revoke_reason` populated. After
   * revocation, subsequent verify calls return `410 PERMIT_REVOKED`.
   *
   * Idempotent on `409 permit_revoked` for already-revoked permits;
   * server returns the existing revoked row in that case.
   *
   * Throws {@link AtlaSentError} on `404` (permit not in calling org),
   * `409` (already in a terminal state), `410` (expired before revoke),
   * or `429` (rate limited).
   */
  async revokePermitById(
    permitId: string,
    input: RevokePermitByIdInput = {},
  ): Promise<RevokePermitByIdResponse> {
    if (!permitId) {
      throw new AtlaSentError("permitId is required", { code: "bad_request" });
    }
    const body: { reason?: string } = {};
    if (input.reason !== undefined) body.reason = input.reason;
    const { body: wire, rateLimit } = await this.post<PermitRecord>(
      `/v1/permits/${encodeURIComponent(permitId)}/revoke`,
      body,
    );
    return { permit: wire, rateLimit };
  }

  /**
   * Verify a permit through the canonical REST surface
   * (`POST /v1/permits/{permitId}/verify`).
   *
   * Returns the unified verification envelope (`valid`,
   * `verification_type: 'permit'`, `reason`, `verified_at`, `evidence`)
   * plus the full {@link PermitRecord} fields preserved at the top
   * level. The `valid` field is the contract — pin to it.
   *
   * A `valid: false` is **not** thrown when the server returns 200 with
   * a denial reason (matches the verify-shape unification on the wire);
   * it is thrown on 4xx (`404` not found, `410` expired/consumed).
   */
  async verifyPermitById(permitId: string): Promise<VerifyPermitByIdResponse> {
    if (!permitId) {
      throw new AtlaSentError("permitId is required", { code: "bad_request" });
    }
    const { body: wire, rateLimit } = await this.post<
      VerifyPermitByIdResponse & PermitRecord
    >(`/v1/permits/${encodeURIComponent(permitId)}/verify`, {});
    // Server returns the canonical envelope merged with the Permit row
    // (allOf in openapi). Pull out the legacy permit row into `permit`
    // for callers that want it as a sub-object too.
    const { valid, verification_type, reason, verified_at, evidence, ...row } =
      wire as VerifyPermitByIdResponse & PermitRecord;
    return {
      valid,
      verification_type,
      reason,
      verified_at,
      evidence,
      permit: row as PermitRecord,
      rateLimit,
    };
  }

  /**
   * Get a single permit's full lifecycle state.
   *
   * Calls `GET /v1/permits/{permitId}` (the canonical REST surface).
   * Returns `status`, all timestamps, `revoked_at` / `revoked_by` /
   * `revoke_reason` (when applicable), and the bound `payload_hash`
   * / `decision_id`.
   *
   * Operator-facing introspection — answers "what state is this permit
   * in, and why?" without reading audit logs.
   *
   * Throws {@link AtlaSentError} on `404` (permit not in calling org)
   * or `410` (expired before retrieval).
   */
  async getPermit(permitId: string): Promise<GetPermitResponse> {
    if (!permitId) {
      throw new AtlaSentError("permitId is required", { code: "bad_request" });
    }
    const { body: wire, rateLimit } = await this.get<PermitRecord>(
      `/v1/permits/${encodeURIComponent(permitId)}`,
    );
    return { permit: wire, rateLimit };
  }

  /**
   * List permits issued to the calling org, most-recently-issued first.
   *
   * Calls `GET /v1/permits` (the canonical REST surface). Cursor-paged.
   * Filters narrow on server side; pagination uses the `created_at`
   * timestamp opaquely (`nextCursor`).
   *
   * Designed for incident review, debugging, and compliance
   * reconstruction.
   */
  async listPermits(
    input: ListPermitsRequest = {},
  ): Promise<ListPermitsResponse> {
    const params = new URLSearchParams();
    if (input.status) params.set("status", input.status);
    if (input.actorId) params.set("actor_id", input.actorId);
    if (input.actionType) params.set("action_type", input.actionType);
    if (input.from) params.set("from", input.from);
    if (input.to) params.set("to", input.to);
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    if (input.cursor) params.set("cursor", input.cursor);

    const { body: wire, rateLimit } = await this.get<{
      permits?: PermitRecord[];
      total?: number;
      next_cursor?: string;
    }>("/v1/permits", params);

    if (!Array.isArray(wire.permits)) {
      throw new AtlaSentError(
        "Malformed response from /v1/permits: missing `permits` array",
        { code: "bad_response" },
      );
    }
    const result: ListPermitsResponse = {
      permits: wire.permits,
      total: typeof wire.total === "number" ? wire.total : wire.permits.length,
      rateLimit,
    };
    if (wire.next_cursor !== undefined) result.nextCursor = wire.next_cursor;
    return result;
  }

  /**
   * Self-introspection: ask the server to describe the API key this
   * client was constructed with. Returns the key's ID, organization,
   * environment, scopes, IP allowlist, per-minute rate limit, the
   * client IP the server observed, and the expiry (if any).
   *
   * Never includes the raw key or its hash. Safe to surface in operator
   * dashboards. Useful for `IP_NOT_ALLOWED` debugging (the server tells
   * you exactly which IP it saw) and for proactive expiry warnings.
   *
   * Throws {@link AtlaSentError} on transport / auth failures — same
   * taxonomy as {@link AtlaSentClient.evaluate}.
   */
  async keySelf(): Promise<ApiKeySelfResponse> {
    const { body: wire, rateLimit } = await this.get<ApiKeySelfWire>(
      "/v1-api-key-self",
    );

    if (typeof wire.key_id !== "string" || typeof wire.organization_id !== "string") {
      throw new AtlaSentError(
        "Malformed response from /v1-api-key-self: missing `key_id` or `organization_id`",
        { code: "bad_response" },
      );
    }

    return {
      keyId: wire.key_id,
      organizationId: wire.organization_id,
      environment: wire.environment,
      scopes: wire.scopes ?? [],
      allowedCidrs: wire.allowed_cidrs ?? null,
      rateLimitPerMinute: wire.rate_limit_per_minute,
      clientIp: wire.client_ip ?? null,
      expiresAt: wire.expires_at ?? null,
      rateLimit,
    };
  }

  /**
   * List persisted audit events for the authenticated organization
   * (`GET /v1-audit/events`). Returned rows are wire-identical with
   * the server: snake_case field names, including `previous_hash` and
   * the `hash` chain, so the response can be fed straight into the
   * offline verifier when paired with a signed export.
   *
   * `query.types` is a comma-joined list (e.g.
   * `"evaluate.allow,policy.updated"`). `cursor` is the opaque
   * `next_cursor` from the prior page. All fields are optional; the
   * server defaults `limit` to 50 (capped at 500).
   *
   * Throws {@link AtlaSentError} on transport / auth failures — same
   * taxonomy as {@link AtlaSentClient.evaluate}.
   */
  async listAuditEvents(
    query: AuditEventsQuery = {},
  ): Promise<AuditEventsResult> {
    const { body: wire, rateLimit } = await this.get<AuditEventsPage>(
      "/v1-audit/events",
      buildAuditEventsQuery(query),
    );

    if (!Array.isArray(wire.events) || typeof wire.total !== "number") {
      throw new AtlaSentError(
        "Malformed response from /v1-audit/events: missing `events` or `total`",
        { code: "bad_response" },
      );
    }

    return { ...wire, rateLimit };
  }

  /**
   * Request a signed audit export bundle
   * (`POST /v1-audit/exports`). The returned object is wire-identical
   * with the server — `signature`, `chain_head_hash`, `events`, and
   * friends survive untouched so the bundle can be persisted to disk
   * and handed to the offline verifier (`verifyBundle` /
   * `verifyAuditBundle`) without any reshaping.
   *
   * Pass `filter.types`, `filter.from`, `filter.to`, or `filter.actor_id`
   * to narrow the export; omit for a full-org bundle. `rateLimit` is
   * attached alongside the wire fields for observability.
   *
   * Throws {@link AtlaSentError} on transport / auth failures — same
   * taxonomy as {@link AtlaSentClient.evaluate}.
   */
  async createAuditExport(
    filter: AuditExportRequest = {},
  ): Promise<AuditExportResult> {
    const { body: wire, rateLimit } = await this.post<AuditExport>(
      "/v1-audit/exports",
      filter,
    );

    if (
      typeof wire.export_id !== "string" ||
      typeof wire.chain_head_hash !== "string" ||
      !Array.isArray(wire.events)
    ) {
      throw new AtlaSentError(
        "Malformed response from /v1-audit/exports: missing required fields",
        { code: "bad_response" },
      );
    }

    return { ...wire, rateLimit };
  }

  // ── HITL Escalation ──────────────────────────────────────────────────────

  /**
   * List HITL escalations for this organization.
   * Calls `GET /v1/hitl/escalations`.
   */
  async listHitlEscalations(
    input: ListHitlEscalationsRequest = {},
  ): Promise<ListHitlEscalationsResponse> {
    const params = new URLSearchParams();
    if (input.status) params.set("status", input.status);
    if (input.actorId) params.set("actor_id", input.actorId);
    if (input.from) params.set("from", input.from);
    if (input.to) params.set("to", input.to);
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    if (input.cursor) params.set("cursor", input.cursor);

    const { body: wire, rateLimit } = await this.get<{
      escalations: HitlEscalation[];
      next_cursor?: string;
    }>("/v1/hitl/escalations", params);

    const result: ListHitlEscalationsResponse = {
      escalations: wire.escalations,
      rateLimit,
    };
    if (wire.next_cursor !== undefined) result.nextCursor = wire.next_cursor;
    return result;
  }

  /**
   * Get a single HITL escalation by ID.
   * Calls `GET /v1/hitl/escalations/{id}`.
   */
  async getHitlEscalation(escalationId: string): Promise<HitlEscalation> {
    if (!escalationId) {
      throw new AtlaSentError("escalationId is required", { code: "bad_request" });
    }
    const { body: wire } = await this.get<HitlEscalation>(
      `/v1/hitl/escalations/${encodeURIComponent(escalationId)}`,
    );
    return wire;
  }

  /**
   * Escalate a decision to a human reviewer.
   * Calls `POST /v1/hitl/escalations`.
   */
  async createHitlEscalation(
    input: HitlEscalateRequest,
  ): Promise<HitlEscalation> {
    const { body: wire } = await this.post<HitlEscalation>(
      "/v1/hitl/escalations",
      input,
    );
    return wire;
  }

  /**
   * Approve a HITL escalation.
   * Calls `POST /v1/hitl/escalations/{id}/approve`.
   */
  async approveHitlEscalation(
    escalationId: string,
    input: HitlApproveRequest,
  ): Promise<HitlApprovalRecord> {
    if (!escalationId) {
      throw new AtlaSentError("escalationId is required", { code: "bad_request" });
    }
    const { body: wire } = await this.post<HitlApprovalRecord>(
      `/v1/hitl/escalations/${encodeURIComponent(escalationId)}/approve`,
      input,
    );
    return wire;
  }

  /**
   * Reject a HITL escalation.
   * Calls `POST /v1/hitl/escalations/{id}/reject`.
   */
  async rejectHitlEscalation(
    escalationId: string,
    input: HitlRejectRequest,
  ): Promise<HitlApprovalRecord> {
    if (!escalationId) {
      throw new AtlaSentError("escalationId is required", { code: "bad_request" });
    }
    const { body: wire } = await this.post<HitlApprovalRecord>(
      `/v1/hitl/escalations/${encodeURIComponent(escalationId)}/reject`,
      input,
    );
    return wire;
  }

  /**
   * Add a hop to a HITL escalation chain.
   * Calls `POST /v1/hitl/escalations/{id}/chain`.
   */
  async chainHitlEscalation(
    escalationId: string,
    input: HitlChainHop,
  ): Promise<HitlEscalation> {
    if (!escalationId) {
      throw new AtlaSentError("escalationId is required", { code: "bad_request" });
    }
    const { body: wire } = await this.post<HitlEscalation>(
      `/v1/hitl/escalations/${encodeURIComponent(escalationId)}/chain`,
      input,
    );
    return wire;
  }

  // ── Governance Graph ─────────────────────────────────────────────────────

  /**
   * Execute a typed governance graph query.
   * Calls `POST /v1/governance/graph/query`.
   */
  async queryGovernanceGraph<T extends GovernanceGraphQueryType>(
    queryType: T,
    params: GovernanceGraphQueryParams<T>,
  ): Promise<GovernanceGraphQueryResponse<T>> {
    const { body: wire } = await this.post<GovernanceGraphQueryResponse<T>>(
      "/v1/governance/graph/query",
      { query_type: queryType, params },
    );
    return wire;
  }

  /**
   * Reconstruct the incident timeline for a specific execution.
   * Calls `GET /v1/governance/incidents/{executionId}/timeline`.
   */
  async getIncidentTimeline(executionId: string): Promise<IncidentTimelineResponse> {
    if (!executionId) {
      throw new AtlaSentError("executionId is required", { code: "bad_request" });
    }
    const { body: wire } = await this.get<IncidentTimelineResponse>(
      `/v1/governance/incidents/${encodeURIComponent(executionId)}/timeline`,
    );
    return wire;
  }

  // ── Connector Management ─────────────────────────────────────────────────

  /**
   * List all connectors registered to the calling org.
   * Calls `GET /v1/connectors`.
   */
  async listConnectors(
    params: { status?: string; type?: ConnectorType } = {},
  ): Promise<ListConnectorsResponse> {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", params.status);
    if (params.type) qs.set("type", params.type);
    const { body, rateLimit } = await this.get<ListConnectorsResponse>(
      "/v1/connectors",
      qs,
    );
    return { ...body, rateLimit };
  }

  /**
   * Install a new connector.
   * Calls `POST /v1/connectors`.
   */
  async installConnector(
    input: InstallConnectorInput,
  ): Promise<InstallConnectorResponse> {
    const { body, rateLimit } = await this.post<InstallConnectorResponse>(
      "/v1/connectors",
      input,
    );
    return { ...body, rateLimit };
  }

  /**
   * Authenticate (re-credential) a connector.
   * Calls `POST /v1/connectors/{id}/authenticate`.
   */
  async authenticateConnector(
    connectorId: string,
    input: AuthenticateConnectorInput,
  ): Promise<AuthenticateConnectorResponse> {
    if (!connectorId) {
      throw new AtlaSentError("connectorId is required", { code: "bad_request" });
    }
    const { body, rateLimit } = await this.post<AuthenticateConnectorResponse>(
      `/v1/connectors/${encodeURIComponent(connectorId)}/authenticate`,
      input,
    );
    return { ...body, rateLimit };
  }

  /**
   * Trigger a manual sync for a connector.
   * Calls `POST /v1/connectors/{id}/sync`.
   */
  async syncConnector(connectorId: string): Promise<SyncConnectorResponse> {
    if (!connectorId) {
      throw new AtlaSentError("connectorId is required", { code: "bad_request" });
    }
    const { body, rateLimit } = await this.post<SyncConnectorResponse>(
      `/v1/connectors/${encodeURIComponent(connectorId)}/sync`,
      {},
    );
    return { ...body, rateLimit };
  }

  /**
   * Revoke (uninstall) a connector.
   * Calls `POST /v1/connectors/{id}/revoke`.
   */
  async revokeConnector(connectorId: string): Promise<RevokeConnectorResponse> {
    if (!connectorId) {
      throw new AtlaSentError("connectorId is required", { code: "bad_request" });
    }
    const { body, rateLimit } = await this.post<RevokeConnectorResponse>(
      `/v1/connectors/${encodeURIComponent(connectorId)}/revoke`,
      {},
    );
    return { ...body, rateLimit };
  }

  /**
   * Rotate credentials for a connector.
   * Calls `POST /v1/connectors/{id}/rotate-credentials`.
   */
  async rotateConnectorCredentials(
    connectorId: string,
  ): Promise<RotateCredentialsResponse> {
    if (!connectorId) {
      throw new AtlaSentError("connectorId is required", { code: "bad_request" });
    }
    const { body, rateLimit } = await this.post<RotateCredentialsResponse>(
      `/v1/connectors/${encodeURIComponent(connectorId)}/rotate-credentials`,
      {},
    );
    return { ...body, rateLimit };
  }

  /**
   * List enforcement policies for a connector.
   * Calls `GET /v1/connectors/{id}/enforcement-policies`.
   */
  async listConnectorEnforcementPolicies(
    connectorId: string,
  ): Promise<ListEnforcementPoliciesResponse> {
    if (!connectorId) {
      throw new AtlaSentError("connectorId is required", { code: "bad_request" });
    }
    const { body, rateLimit } = await this.get<ListEnforcementPoliciesResponse>(
      `/v1/connectors/${encodeURIComponent(connectorId)}/enforcement-policies`,
    );
    return { ...body, rateLimit };
  }

  /**
   * Upsert an enforcement policy on a connector.
   * Calls `POST /v1/connectors/{id}/enforcement-policies`.
   */
  async upsertConnectorEnforcementPolicy(
    connectorId: string,
    input: UpsertEnforcementPolicyInput,
  ): Promise<UpsertEnforcementPolicyResponse> {
    if (!connectorId) {
      throw new AtlaSentError("connectorId is required", { code: "bad_request" });
    }
    const { body, rateLimit } = await this.post<UpsertEnforcementPolicyResponse>(
      `/v1/connectors/${encodeURIComponent(connectorId)}/enforcement-policies`,
      input,
    );
    return { ...body, rateLimit };
  }

  // ── Organizational Risk Graph ─────────────────────────────────────────────

  /**
   * Trigger a fresh org-level risk score computation.
   * Calls `POST /v1/governance/risk/compute`.
   */
  async computeOrgRisk(
    options: ComputeOrgRiskOptions = {},
  ): Promise<ComputeOrgRiskResponse> {
    const { body, rateLimit } = await this.post<
      ComputeOrgRiskResponse["score"]
    >("/v1/governance/risk/compute", options);
    return { score: body, rateLimit };
  }

  /**
   * Retrieve the most recently computed risk score for the calling org.
   * Calls `GET /v1/governance/risk/latest`.
   */
  async getLatestOrgRisk(): Promise<GetLatestOrgRiskResponse> {
    const { body, rateLimit } = await this.get<{
      score: GetLatestOrgRiskResponse["score"];
    }>("/v1/governance/risk/latest");
    return { score: body.score ?? null, rateLimit };
  }

  /**
   * Page through historical org risk scores, most-recent first.
   * Calls `GET /v1/governance/risk/history`.
   */
  async listOrgRiskHistory(
    options: { cursor?: string; limit?: number } = {},
  ): Promise<ListOrgRiskHistoryResponse> {
    const params = new URLSearchParams();
    if (options.cursor) params.set("cursor", options.cursor);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const { body, rateLimit } = await this.get<{
      scores: ListOrgRiskHistoryResponse["scores"];
      total: number;
      next_cursor?: string;
    }>("/v1/governance/risk/history", params);
    const result: ListOrgRiskHistoryResponse = {
      scores: body.scores ?? [],
      total: body.total,
      rateLimit,
    };
    if (body.next_cursor) result.nextCursor = body.next_cursor;
    return result;
  }

  // ── Cross-Org Permission Negotiation ──────────────────────────────────────

  async checkCrossOrgPermission(
    req: CrossOrgPermissionCheckRequest,
  ): Promise<CrossOrgPermissionCheckResult> {
    const { body } = await this.post<CrossOrgPermissionCheckResult>(
      "/v1/cross-org/permissions/check",
      req,
    );
    return body;
  }

  async listCrossOrgPermissionChecks(
    params?: CrossOrgPermissionCheckListParams,
  ): Promise<CrossOrgPermissionCheckResult[]> {
    const qs = new URLSearchParams();
    if (params?.source_org_id) qs.set("source_org_id", params.source_org_id);
    if (params?.target_org_id) qs.set("target_org_id", params.target_org_id);
    if (params?.allowed !== undefined) qs.set("allowed", String(params.allowed));
    if (params?.limit !== undefined) qs.set("limit", String(params.limit));
    const { body } = await this.get<{ checks: CrossOrgPermissionCheckResult[] }>(
      "/v1/cross-org/permissions/checks",
      qs,
    );
    return body.checks ?? [];
  }

  // ── Anomaly Response Automation ───────────────────────────────────────────

  async listAnomalyResponseRules(): Promise<AnomalyResponseRule[]> {
    const { body } = await this.get<{ rules: AnomalyResponseRule[] }>(
      "/v1/anomaly-response/rules",
    );
    return body.rules ?? [];
  }

  async createAnomalyResponseRule(
    req: CreateAnomalyResponseRuleRequest,
  ): Promise<AnomalyResponseRule> {
    const { body } = await this.post<AnomalyResponseRule>(
      "/v1/anomaly-response/rules",
      req,
    );
    return body;
  }

  async updateAnomalyResponseRule(
    id: string,
    updates: Partial<CreateAnomalyResponseRuleRequest>,
  ): Promise<AnomalyResponseRule> {
    const { body } = await this.post<AnomalyResponseRule>(
      `/v1/anomaly-response/rules/${encodeURIComponent(id)}/update`,
      updates,
    );
    return body;
  }

  async deleteAnomalyResponseRule(id: string): Promise<void> {
    await this.post<Record<string, unknown>>(
      `/v1/anomaly-response/rules/${encodeURIComponent(id)}/delete`,
      {},
    );
  }

  async triggerAnomalyResponse(
    req: TriggerAnomalyResponseRequest,
  ): Promise<AnomalyResponseEvent[]> {
    const { body } = await this.post<{ events: AnomalyResponseEvent[] }>(
      "/v1/anomaly-response/trigger",
      req,
    );
    return body.events ?? [];
  }

  async listAnomalyResponseEvents(
    params?: { limit?: number; execution_id?: string },
  ): Promise<AnomalyResponseEvent[]> {
    const qs = new URLSearchParams();
    if (params?.execution_id) qs.set("execution_id", params.execution_id);
    if (params?.limit !== undefined) qs.set("limit", String(params.limit));
    const { body } = await this.get<{ events: AnomalyResponseEvent[] }>(
      "/v1/anomaly-response/events",
      qs,
    );
    return body.events ?? [];
  }

  // ── Budget Exception Workflows ────────────────────────────────────────────

  async listBudgetExceptions(
    params?: { status?: BudgetExceptionStatus; budget_policy_id?: string; limit?: number; offset?: number },
  ): Promise<BudgetExceptionRequest[]> {
    const qs = new URLSearchParams();
    if (params?.status) qs.set("status", params.status);
    if (params?.budget_policy_id) qs.set("budget_policy_id", params.budget_policy_id);
    if (params?.limit !== undefined) qs.set("limit", String(params.limit));
    if (params?.offset !== undefined) qs.set("offset", String(params.offset));
    const { body } = await this.get<{ exceptions: BudgetExceptionRequest[] }>(
      "/v1/budget-exceptions",
      qs,
    );
    return body.exceptions ?? [];
  }

  async getBudgetException(id: string): Promise<BudgetExceptionRequest> {
    const { body } = await this.get<BudgetExceptionRequest>(
      `/v1/budget-exceptions/${encodeURIComponent(id)}`,
    );
    return body;
  }

  async createBudgetException(
    req: CreateBudgetExceptionRequest,
  ): Promise<BudgetExceptionRequest> {
    const { body } = await this.post<BudgetExceptionRequest>(
      "/v1/budget-exceptions",
      req,
    );
    return body;
  }

  async approveBudgetException(
    id: string,
    req: ApproveBudgetExceptionRequest,
  ): Promise<BudgetExceptionRequest> {
    const { body } = await this.post<BudgetExceptionRequest>(
      `/v1/budget-exceptions/${encodeURIComponent(id)}/approve`,
      req,
    );
    return body;
  }

  async rejectBudgetException(
    id: string,
    review_notes?: string,
  ): Promise<BudgetExceptionRequest> {
    const { body } = await this.post<BudgetExceptionRequest>(
      `/v1/budget-exceptions/${encodeURIComponent(id)}/reject`,
      { review_notes },
    );
    return body;
  }

  async cancelBudgetException(id: string): Promise<BudgetExceptionRequest> {
    const { body } = await this.post<BudgetExceptionRequest>(
      `/v1/budget-exceptions/${encodeURIComponent(id)}/cancel`,
      {},
    );
    return body;
  }

  // ── Regulatory Escalation Chain ───────────────────────────────────────────

  async listRegulatoryAuthorityLevels(): Promise<RegulatoryAuthorityLevel[]> {
    const { body } = await this.get<{ levels: RegulatoryAuthorityLevel[] }>(
      "/v1/regulatory/authority-levels",
    );
    return body.levels ?? [];
  }

  async createRegulatoryAuthorityLevel(
    req: Omit<RegulatoryAuthorityLevel, "id" | "org_id" | "created_at">,
  ): Promise<RegulatoryAuthorityLevel> {
    const { body } = await this.post<RegulatoryAuthorityLevel>(
      "/v1/regulatory/authority-levels",
      req,
    );
    return body;
  }

  async listRegulatoryEscalations(
    params?: { status?: RegulatoryEscalationStatus; subject_type?: string; subject_id?: string },
  ): Promise<RegulatoryEscalation[]> {
    const qs = new URLSearchParams();
    if (params?.status) qs.set("status", params.status);
    if (params?.subject_type) qs.set("subject_type", params.subject_type);
    if (params?.subject_id) qs.set("subject_id", params.subject_id);
    const { body } = await this.get<{ escalations: RegulatoryEscalation[] }>(
      "/v1/regulatory/escalations",
      qs,
    );
    return body.escalations ?? [];
  }

  async createRegulatoryEscalation(
    req: CreateRegulatoryEscalationRequest,
  ): Promise<RegulatoryEscalation> {
    const { body } = await this.post<RegulatoryEscalation>(
      "/v1/regulatory/escalations",
      req,
    );
    return body;
  }

  async acknowledgeRegulatoryEscalation(id: string): Promise<RegulatoryEscalation> {
    const { body } = await this.post<RegulatoryEscalation>(
      `/v1/regulatory/escalations/${encodeURIComponent(id)}/acknowledge`,
      {},
    );
    return body;
  }

  async resolveRegulatoryEscalation(
    id: string,
    resolution: string,
    resolution_details?: Record<string, unknown>,
  ): Promise<RegulatoryEscalation> {
    const { body } = await this.post<RegulatoryEscalation>(
      `/v1/regulatory/escalations/${encodeURIComponent(id)}/resolve`,
      { resolution, resolution_details },
    );
    return body;
  }

  async overrideRegulatoryEscalation(
    id: string,
    reason: string,
  ): Promise<RegulatoryEscalation> {
    const { body } = await this.post<RegulatoryEscalation>(
      `/v1/regulatory/escalations/${encodeURIComponent(id)}/override`,
      { reason },
    );
    return body;
  }

  // ── Incentive Signal Feedback Loop ────────────────────────────────────────

  async listSignalActions(signal_id: string): Promise<GovernanceSignalAction[]> {
    const { body } = await this.get<{ actions: GovernanceSignalAction[] }>(
      `/v1/governance/signals/${encodeURIComponent(signal_id)}/actions`,
    );
    return body.actions ?? [];
  }

  async recordSignalAction(
    signal_id: string,
    req: RecordSignalActionRequest,
  ): Promise<GovernanceSignalAction> {
    const { body } = await this.post<GovernanceSignalAction>(
      `/v1/governance/signals/${encodeURIComponent(signal_id)}/actions`,
      req,
    );
    return body;
  }

  async recordSignalOutcome(
    signal_id: string,
    action_id: string,
    req: RecordSignalOutcomeRequest,
  ): Promise<GovernanceSignalAction> {
    const { body } = await this.post<GovernanceSignalAction>(
      `/v1/governance/signals/${encodeURIComponent(signal_id)}/actions/${encodeURIComponent(action_id)}/outcome`,
      req,
    );
    return body;
  }

  async getSignalActionSummary(): Promise<SignalActionSummary> {
    const { body } = await this.get<SignalActionSummary>(
      "/v1/governance/signals/actions/summary",
    );
    return body;
  }

  // ── Cross-Org Impersonation ───────────────────────────────────────────────

  async listImpersonationGrants(): Promise<CrossOrgImpersonationGrant[]> {
    const { body } = await this.get<{ grants: CrossOrgImpersonationGrant[] }>(
      "/v1/cross-org/impersonation/grants",
    );
    return body.grants ?? [];
  }

  async createImpersonationGrant(
    req: CreateImpersonationGrantRequest,
  ): Promise<CrossOrgImpersonationGrant> {
    const { body } = await this.post<CrossOrgImpersonationGrant>(
      "/v1/cross-org/impersonation/grants",
      req,
    );
    return body;
  }

  async revokeImpersonationGrant(id: string): Promise<void> {
    await this.post<Record<string, unknown>>(
      `/v1/cross-org/impersonation/grants/${encodeURIComponent(id)}/revoke`,
      {},
    );
  }

  async issueImpersonationToken(
    grant_id: string,
    requested_duration_seconds?: number,
  ): Promise<ImpersonationToken> {
    const { body } = await this.post<ImpersonationToken>(
      `/v1/cross-org/impersonation/grants/${encodeURIComponent(grant_id)}/token`,
      { requested_duration_seconds },
    );
    return body;
  }

  async validateImpersonationToken(
    token: string,
  ): Promise<ImpersonationValidationResult> {
    const { body } = await this.post<ImpersonationValidationResult>(
      "/v1/cross-org/impersonation/validate",
      { token },
    );
    return body;
  }

  private async post<T>(
    path: string,
    body: unknown,
    query?: URLSearchParams,
  ): Promise<{ body: T; rateLimit: RateLimitState | null }> {
    return this.request<T>(path, "POST", body, query);
  }

  private async get<T>(
    path: string,
    query?: URLSearchParams,
  ): Promise<{ body: T; rateLimit: RateLimitState | null }> {
    return this.request<T>(path, "GET", undefined, query);
  }

  private async request<T>(
    path: string,
    method: "GET" | "POST",
    body: unknown,
    query: URLSearchParams | undefined,
  ): Promise<{ body: T; rateLimit: RateLimitState | null }> {
    const qs = query && Array.from(query).length > 0 ? `?${query.toString()}` : "";
    const url = `${this.baseUrl}${path}${qs}`;
    const requestId = globalThis.crypto.randomUUID();

    /**
     * Canonical auth header. The API also accepts X-AtlaSent-Key for legacy
     * compatibility but that path is deprecated and will be removed in a future
     * version. Always use Authorization: Bearer <api_key>.
     */
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      "User-Agent": this.userAgent,
      "X-Request-ID": requestId,
    };
    if (method === "POST") headers["Content-Type"] = "application/json";

    const bodyStr = method === "POST" ? JSON.stringify(body) : undefined;

    for (let attempt = 0; ; attempt++) {
      const init: RequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      };
      if (bodyStr !== undefined) init.body = bodyStr;

      let response: Response;
      try {
        response = await this.fetchImpl(url, init);
      } catch (err) {
        const mapped = mapFetchError(err, requestId);
        if (isRetryable(mapped) && hasAttemptsLeft(attempt, this.retryPolicy)) {
          await sleep(computeBackoffMs(attempt, this.retryPolicy, mapped));
          continue;
        }
        throw mapped;
      }

      if (!response.ok) {
        const httpErr = await buildHttpError(response, requestId);
        if (isRetryable(httpErr) && hasAttemptsLeft(attempt, this.retryPolicy)) {
          await sleep(computeBackoffMs(attempt, this.retryPolicy, httpErr));
          continue;
        }
        throw httpErr;
      }

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch (err) {
        const jsonErr = new AtlaSentError("Invalid JSON response from AtlaSent API", {
          code: "bad_response",
          status: response.status,
          requestId,
          cause: err,
        });
        if (isRetryable(jsonErr) && hasAttemptsLeft(attempt, this.retryPolicy)) {
          await sleep(computeBackoffMs(attempt, this.retryPolicy, jsonErr));
          continue;
        }
        throw jsonErr;
      }

      if (parsed === null || typeof parsed !== "object") {
        const shapeErr = new AtlaSentError("Expected a JSON object from AtlaSent API", {
          code: "bad_response",
          status: response.status,
          requestId,
        });
        if (isRetryable(shapeErr) && hasAttemptsLeft(attempt, this.retryPolicy)) {
          await sleep(computeBackoffMs(attempt, this.retryPolicy, shapeErr));
          continue;
        }
        throw shapeErr;
      }

      return {
        body: parsed as T,
        rateLimit: parseRateLimitHeaders(response.headers),
      };
    }
  }

  async *protectStream(
    input: EvaluateRequest,
    options: StreamOptions = {},
  ): AsyncIterable<StreamEvent> {
    _warnOversizeContext(input.context);

    const url = `${this.baseUrl}/v1-protect-stream`;
    const requestId = globalThis.crypto.randomUUID();
    let lastEventId = options.lastEventId ?? null;

    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": this.userAgent,
      "X-Request-ID": requestId,
    };
    if (lastEventId) {
      headers["Last-Event-ID"] = lastEventId;
    }

    const timeoutMs =
      options.perEventTimeoutMs ?? (this.timeoutMs > 0 ? this.timeoutMs * 3 : 0);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(input),
        signal: options.signal,
      });
    } catch (err) {
      throw mapFetchError(err, requestId);
    }

    if (!response.ok) {
      throw await buildHttpError(response, requestId);
    }

    if (!response.body) {
      throw new AtlaSentError("AtlaSent stream returned no body", {
        code: "bad_response",
        requestId,
      });
    }

    yield* parseSseStream(response.body, requestId, timeoutMs, (id) => {
      lastEventId = id;
    });
  }
}

function parseRateLimitHeaders(headers: Headers): RateLimitState | null {
  const rawLimit = headers.get("x-ratelimit-limit");
  const rawRemaining = headers.get("x-ratelimit-remaining");
  const rawReset = headers.get("x-ratelimit-reset");
  if (rawLimit === null || rawRemaining === null || rawReset === null) {
    return null;
  }
  const limit = Number(rawLimit);
  const remaining = Number(rawRemaining);
  if (!Number.isFinite(limit) || !Number.isFinite(remaining)) {
    return null;
  }
  const resetAt = parseResetHeader(rawReset);
  if (resetAt === null) {
    return null;
  }
  return { limit, remaining, resetAt };
}

function parseResetHeader(raw: string): Date | null {
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    return new Date(seconds * 1000);
  }
  const ms = Date.parse(raw);
  if (Number.isFinite(ms)) {
    return new Date(ms);
  }
  return null;
}

function mapFetchError(err: unknown, requestId: string): AtlaSentError {
  if (err instanceof AtlaSentError) return err;
  if (err instanceof DOMException && err.name === "TimeoutError") {
    return new AtlaSentError("Request to AtlaSent API timed out", {
      code: "timeout",
      requestId,
      cause: err,
    });
  }
  if (err instanceof Error && err.name === "AbortError") {
    return new AtlaSentError("Request to AtlaSent API timed out", {
      code: "timeout",
      requestId,
      cause: err,
    });
  }
  const message = err instanceof Error ? err.message : "network error";
  return new AtlaSentError(`Failed to reach AtlaSent API: ${message}`, {
    code: "network",
    requestId,
    cause: err,
  });
}

async function buildHttpError(
  response: Response,
  requestId: string,
): Promise<AtlaSentError> {
  const status = response.status;
  const classified = await classifyHttpStatus(response);
  const init: AtlaSentErrorInit = {
    status,
    code: classified.code,
    requestId,
  };
  if (classified.retryAfterMs !== undefined) {
    init.retryAfterMs = classified.retryAfterMs;
  }
  return new AtlaSentError(classified.message, init);
}

async function classifyHttpStatus(response: Response): Promise<{
  message: string;
  code: AtlaSentErrorCode;
  retryAfterMs: number | undefined;
}> {
  const status = response.status;
  const serverMessage = await readServerMessage(response);

  if (status === 401) {
    return {
      message: serverMessage ?? "Invalid API key",
      code: "invalid_api_key",
      retryAfterMs: undefined,
    };
  }
  if (status === 403) {
    return {
      message:
        serverMessage ?? "Access forbidden — check your API key permissions",
      code: "forbidden",
      retryAfterMs: undefined,
    };
  }
  if (status === 429) {
    return {
      message: serverMessage ?? "Rate limited by AtlaSent API",
      code: "rate_limited",
      retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
    };
  }
  if (status >= 500) {
    return {
      message: serverMessage ?? `AtlaSent API returned HTTP ${status}`,
      code: "server_error",
      retryAfterMs: undefined,
    };
  }
  return {
    message: serverMessage ?? `AtlaSent API returned HTTP ${status}`,
    code: "bad_request",
    retryAfterMs: undefined,
  };
}

async function readServerMessage(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    if (!text) return null;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") {
        const msg = (parsed as Record<string, unknown>).message;
        const reason = (parsed as Record<string, unknown>).reason;
        if (typeof msg === "string" && msg.length > 0) return msg;
        if (typeof reason === "string" && reason.length > 0) return reason;
      }
    } catch {
      // Fall through — treat as plain text.
    }
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  } catch {
    return null;
  }
}

function buildAuditEventsQuery(query: AuditEventsQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.types !== undefined && query.types !== "") {
    params.set("types", query.types);
  }
  if (query.actor_id !== undefined && query.actor_id !== "") {
    params.set("actor_id", query.actor_id);
  }
  if (query.from !== undefined && query.from !== "") {
    params.set("from", query.from);
  }
  if (query.to !== undefined && query.to !== "") {
    params.set("to", query.to);
  }
  if (query.limit !== undefined) {
    params.set("limit", String(query.limit));
  }
  if (query.cursor !== undefined && query.cursor !== "") {
    params.set("cursor", query.cursor);
  }
  return params;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) {
    const delta = date - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  requestId: string,
  timeoutMs: number,
  onEventId: (id: string) => void,
): AsyncIterable<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";

  type ChunkResult = { done: true; value?: undefined } | { done: false; value: Uint8Array };

  async function readChunk(): Promise<ChunkResult> {
    if (timeoutMs <= 0) {
      return reader.read() as Promise<ChunkResult>;
    }
    return new Promise<ChunkResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new StreamTimeoutError(timeoutMs));
      }, timeoutMs);
      (reader.read() as Promise<ChunkResult>).then(
        (result) => { clearTimeout(timer); resolve(result); },
        (err: unknown) => { clearTimeout(timer); reject(err); },
      );
    });
  }

  try {
    for (;;) {
      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        const result = await readChunk();
        done = result.done;
        value = result.value;
      } catch (err) {
        if (err instanceof StreamTimeoutError) throw err;
        throw new AtlaSentError(
          `AtlaSent stream read failed: ${err instanceof Error ? err.message : String(err)}`,
          { code: "network", requestId, cause: err },
        );
      }

      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let boundary: number;
      while ((boundary = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, boundary);
        buf = buf.slice(boundary + 2);

        let eventType = "message";
        let data = "";
        let eventId: string | undefined;
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) eventType = line.slice(7).trim();
          else if (line.startsWith("data: ")) data = line.slice(6);
          else if (line.startsWith("id: ")) eventId = line.slice(4).trim();
          else if (line.startsWith("id:")) eventId = line.slice(3).trim();
        }

        if (eventId !== undefined) onEventId(eventId);

        if (!data) continue;
        if (eventType === "done") return;

        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch (err) {
          throw new StreamParseError(data, err);
        }

        if (eventType === "error") {
          const e = parsed as { code?: string; message?: string; request_id?: string };
          throw new AtlaSentError(e.message ?? "Stream error from AtlaSent API", {
            code: (e.code as AtlaSentErrorCode | undefined) ?? "server_error",
            requestId: e.request_id ?? requestId,
          });
        }

        if (eventType === "decision") {
          const d = parsed as {
            permitted?: boolean;
            decision_id?: string;
            reason?: string;
            audit_hash?: string;
            timestamp?: string;
            is_final?: boolean;
            done?: boolean;
          };
          if (typeof d.permitted !== "boolean" || typeof d.decision_id !== "string") {
            throw new AtlaSentError("Malformed decision event from AtlaSent API", {
              code: "bad_response",
              requestId,
            });
          }
          const streamDecision = d.permitted ? "allow" : "deny";
          const isFinal = d.is_final ?? false;
          yield {
            type: "decision",
            decision: streamDecision,
            decision_canonical: streamDecision,
            permitId: d.decision_id,
            reason: d.reason ?? "",
            auditHash: d.audit_hash ?? "",
            timestamp: d.timestamp ?? "",
            isFinal,
          } satisfies StreamDecisionEvent;

          if (isFinal || d.done === true) return;
        } else if (eventType === "progress") {
          const p = parsed as Record<string, unknown>;
          yield { type: "progress", stage: String(p["stage"] ?? ""), ...p } satisfies StreamProgressEvent;
          if ((p as Record<string, unknown>).done === true) return;
        } else {
          if (
            parsed !== null &&
            typeof parsed === "object" &&
            (parsed as Record<string, unknown>).done === true
          ) {
            return;
          }
        }
      }
    }

    if (buf.trim().length > 0) {
      throw new StreamParseError(buf);
    }
  } finally {
    reader.releaseLock();
  }
}
