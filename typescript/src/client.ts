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
   * removed in the next major.
   *
   * Calls `POST /v1-evaluate`.
   */
  async evaluate(
    request: EvaluateRequest | LegacyEvaluateRequest | V2EvaluateRequest,
  ): Promise<EvaluateResponse> {
    const normalized = normalizeEvaluateRequest(request as EvaluateRequest);
    _warnOversizeContext(
      (normalized as { context?: Record<string, unknown> }).context,
    );
    const { body, rateLimit } = await this.post<EvaluateWire>(
      "/v1-evaluate",
      normalized,
    );

    // Canonical shape (new deployments).
    if ("decision" in body && typeof body.decision === "string") {
      const permitToken =
        body.decision === "allow" ? (body.permit_token ?? null) : null;
      const denial =
        body.decision !== "allow"
          ? {
              reason: body.denial?.reason ?? body.reason ?? "policy denied",
              code: body.denial?.code,
            }
          : undefined;
      return {
        decision: body.decision,
        permitToken,
        requestId: body.request_id ?? null,
        expiresAt: body.expires_at ?? null,
        denial,
        rateLimit,
      };
    }

    // Legacy shape (older deployments).
    const permitted = Boolean(body.permitted);
    return {
      decision: permitted ? "allow" : "deny",
      permitToken: permitted ? (body.decision_id ?? null) : null,
      requestId: body.request_id ?? null,
      expiresAt: null,
      denial: permitted
        ? undefined
        : {
            reason: body.reason ?? "policy denied",
            code: undefined,
          },
      rateLimit,
    };
  }

  /**
   * Run a preflight evaluate (with constraint trace) to understand
   * which policy rules are blocking or allowing an action before
   * committing to it.
   *
   * Calls `POST /v1-evaluate?include=constraint_trace`.
   *
   * AND the per-policy trace, so the caller branches on
   * `result.constraintTrace` being non-null.
   */
  async evaluatePreflight(
    request: EvaluateRequest,
  ): Promise<EvaluatePreflightResponse> {
    _warnOversizeContext(
      (request as { context?: Record<string, unknown> }).context,
    );
    const query = new URLSearchParams({ include: "constraint_trace" });
    const { body, rateLimit } = await this.post<EvaluateWire>(
      "/v1-evaluate",
      request,
      query,
    );

    const permitted = body.decision === "allow" || Boolean(body.permitted);
    const denial: { reason: string; code?: string } | undefined = !permitted
      ? {
          reason: body.denial?.reason ?? body.reason ?? "policy denied",
          code: body.denial?.code,
        }
      : undefined;

    const constraintTrace: ConstraintTrace | null =
      body.constraint_trace != null
        ? (body.constraint_trace as ConstraintTrace)
        : null;

    return {
      decision: permitted ? "allow" : "deny",
      permitToken:
        permitted ? (body.permit_token ?? body.decision_id ?? null) : null,
      requestId: body.request_id ?? null,
      expiresAt: body.expires_at ?? null,
      denial,
      constraintTrace,
      rateLimit,
    };
  }

  /**
   * Verify that a permit token is still valid and has not been revoked.
   *
   * Calls `POST /v1-verify-permit`.
   */
  async verifyPermit(
    request: VerifyPermitRequest,
  ): Promise<VerifyPermitResponse> {
    const { body, rateLimit } = await this.post<VerifyPermitWire>(
      "/v1-verify-permit",
      request,
    );
    const valid = body.valid ?? body.verified ?? false;
    return {
      valid,
      outcome: body.outcome ?? (valid ? "allow" : "deny"),
      verifyErrorCode: body.verify_error_code,
      reason: body.reason,
      permitHash: body.permit_hash,
      timestamp: body.timestamp,
      rateLimit,
    };
  }

  /**
   * Revoke a permit by its token string. The token is no longer valid
   * after a successful revoke.
   *
   * Calls `POST /v1-revoke-permit`.
   */
  async revokePermit(input: RevokePermitRequest): Promise<RevokePermitResponse> {
    const { body, rateLimit } = await this.post<{
      revoked: boolean;
      permit_token: string;
      revoked_at: string;
    }>("/v1-revoke-permit", input);
    return {
      revoked: body.revoked ?? false,
      permitToken: body.permit_token,
      revokedAt: body.revoked_at,
      rateLimit,
    };
  }

  /**
   * Revoke a permit by its database ID (UUID). Useful when you stored
   * the permit_id at evaluation time and need to revoke it later
   * without needing to re-present the token.
   *
   * Calls `POST /v1/permits/:id/revoke`.
   */
  async revokePermitById(
    input: RevokePermitByIdInput,
  ): Promise<RevokePermitByIdResponse> {
    if (!input.permitId) {
      throw new AtlaSentError("permitId is required", { code: "bad_request" });
    }
    const { body, rateLimit } = await this.post<{
      revoked: boolean;
      permit_id: string;
      revoked_at: string;
    }>(`/v1/permits/${encodeURIComponent(input.permitId)}/revoke`, {});
    return {
      revoked: body.revoked ?? false,
      permitId: body.permit_id,
      revokedAt: body.revoked_at,
      rateLimit,
    };
  }

  /**
   * Verify a permit by its database ID. Avoids re-presenting the full
   * token when the verifier only stored the UUID.
   *
   * Calls `GET /v1/permits/:id/verify`.
   */
  async verifyPermitById(permitId: string): Promise<VerifyPermitByIdResponse> {
    if (!permitId) {
      throw new AtlaSentError("permitId is required", { code: "bad_request" });
    }
    const { body, rateLimit } = await this.get<{
      valid: boolean;
      outcome: "allow" | "deny";
      verify_error_code?: string;
      reason?: string;
    }>(`/v1/permits/${encodeURIComponent(permitId)}/verify`);
    return {
      valid: body.valid,
      outcome: body.outcome ?? (body.valid ? "allow" : "deny"),
      verifyErrorCode: body.verify_error_code,
      reason: body.reason,
      rateLimit,
    };
  }

  /**
   * Retrieve a single permit record by UUID.
   *
   * Calls `GET /v1/permits/:id`.
   */
  async getPermit(permitId: string): Promise<GetPermitResponse> {
    if (!permitId) {
      throw new AtlaSentError("permitId is required", { code: "bad_request" });
    }
    const { body, rateLimit } = await this.get<PermitRecord>(
      `/v1/permits/${encodeURIComponent(permitId)}`,
    );
    return { permit: body, rateLimit };
  }

  /**
   * List permits with optional filters.
   *
   * Calls `GET /v1/permits`.
   */
  async listPermits(
    input: ListPermitsRequest = {},
  ): Promise<ListPermitsResponse> {
    const params = new URLSearchParams();
    if (input.agentId) params.set("agent_id", input.agentId);
    if (input.status) params.set("status", input.status);
    if (input.actionType) params.set("action_type", input.actionType);
    if (input.from) params.set("from", input.from);
    if (input.to) params.set("to", input.to);
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    if (input.cursor) params.set("cursor", input.cursor);
    const { body, rateLimit } = await this.get<{
      data: PermitRecord[];
      cursor?: string;
      has_more: boolean;
    }>("/v1/permits", params);
    return {
      data: body.data ?? [],
      cursor: body.cursor,
      hasMore: body.has_more ?? false,
      rateLimit,
    };
  }

  /**
   * Inspect the calling API key's metadata and permissions.
   *
   * Calls `GET /v1-api-key-self`.
   */
  async keySelf(): Promise<ApiKeySelfResponse> {
    const { body, rateLimit } = await this.get<ApiKeySelfWire>(
      "/v1-api-key-self",
    );
    return {
      keyId: body.key_id,
      organizationId: body.organization_id,
      environment: body.environment,
      scopes: body.scopes ?? [],
      allowedCidrs: body.allowed_cidrs ?? null,
      rateLimitPerMinute: body.rate_limit_per_minute,
      clientIp: body.client_ip ?? null,
      expiresAt: body.expires_at ?? null,
      rateLimit,
    };
  }

  /**
   * List audit events with optional filters. The cursor is returned in
   * `result.nextCursor` when more pages exist.
   *
   * Calls `GET /v1/audit/events`.
   */
  async listAuditEvents(
    query: AuditEventsQuery = {},
  ): Promise<AuditEventsResult> {
    const params = buildAuditEventsQuery(query);
    const { body, rateLimit } = await this.get<AuditEventsPage>(
      "/v1/audit/events",
      params,
    );
    return { page: body, rateLimit };
  }

  /**
   * Create an audit export job. Returns the export record, which
   * transitions to `ready` once the server has assembled the bundle.
   *
   * Calls `POST /v1/audit/exports`.
   */
  async createAuditExport(
    request: AuditExportRequest,
  ): Promise<AuditExportResult> {
    const { body, rateLimit } = await this.post<AuditExport>(
      "/v1/audit/exports",
      request,
    );
    return { export: body, rateLimit };
  }

  /**
   * Open a streaming SSE connection that emits decisions as they are
   * made (rather than waiting for the full evaluation to complete).
   *
   * The AsyncIterable yields:
   *   - `StreamProgressEvent` — intermediate progress updates
   *   - `StreamDecisionEvent` — the terminal decision (isFinal: true)
   *
   * The stream closes when a terminal decision or `event: done` is
   * received, or when `options.signal` is aborted.
   *
   * Reconnection: pass `options.lastEventId` to resume from the last
   * successfully processed event ID. AtlaSent will replay any events
   * that occurred after that ID.
   *
   * Calls `POST /v1-protect-stream`.
   */
  async *protectStream(
    request: EvaluateRequest,
    options: StreamOptions = {},
  ): AsyncIterable<StreamEvent> {
    _warnOversizeContext(
      (request as { context?: Record<string, unknown> }).context,
    );

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
        body: JSON.stringify(request),
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

  /**
   * List HITL escalations for the calling org. Defaults to
   * `status=pending`; pass `status` to query other queues
   * (`escalated`, `approved`, `rejected`, `auto_approved`,
   * `timed_out`).
   *
   * Calls `GET /v1/hitl`.
   */
  async listHitlEscalations(
    input: ListHitlEscalationsRequest = {},
  ): Promise<{ data: ListHitlEscalationsResponse; rateLimit: RateLimitState | null }> {
    const params = new URLSearchParams();
    if (input.status) params.set("status", input.status);
    if (input.agentId) params.set("agent_id", input.agentId);
    if (input.assignedToUserId) params.set("assigned_to_user_id", input.assignedToUserId);
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    if (input.cursor) params.set("cursor", input.cursor);
    const { body, rateLimit } = await this.get<ListHitlEscalationsResponse>(
      "/v1/hitl",
      params,
    );
    return { data: body, rateLimit };
  }

  /**
   * Get a HITL escalation. The server payload includes a live
   * `quorum_progress` snapshot when the escalation is still open.
   *
   * Calls `GET /v1/hitl/:id`.
   */
  async getHitlEscalation(
    escalationId: string,
  ): Promise<{ escalation: HitlEscalation; rateLimit: RateLimitState | null }> {
    if (!escalationId) {
      throw new AtlaSentError("escalationId is required", { code: "bad_request" });
    }
    const { body, rateLimit } = await this.get<HitlEscalation>(
      `/v1/hitl/${encodeURIComponent(escalationId)}`,
    );
    return { escalation: body, rateLimit };
  }

  /**
   * List per-approver vote rows for an escalation.
   * Calls `GET /v1/hitl/:id/approvals`.
   */
  async listHitlApprovals(
    escalationId: string,
  ): Promise<{ approvals: HitlApprovalRecord[]; rateLimit: RateLimitState | null }> {
    const { body, rateLimit } = await this.get<{ approvals: HitlApprovalRecord[] }>(
      `/v1/hitl/${encodeURIComponent(escalationId)}/approvals`,
    );
    return { approvals: body.approvals ?? [], rateLimit };
  }

  /**
   * List the escalation chain hops for an escalation. Each `/escalate`
   * call appends one row.
   * Calls `GET /v1/hitl/:id/chain`.
   */
  async getHitlChain(
    escalationId: string,
  ): Promise<{ chain: HitlChainHop[]; rateLimit: RateLimitState | null }> {
    const { body, rateLimit } = await this.get<{ chain: HitlChainHop[] }>(
      `/v1/hitl/${encodeURIComponent(escalationId)}/chain`,
    );
    return { chain: body.chain ?? [], rateLimit };
  }

  /**
   * Record an approve vote. Resolves the escalation only once the
   * server-side quorum count is satisfied; before that the response
   * carries a refreshed escalation row with the latest
   * `quorum_progress`.
   *
   * Calls `POST /v1/hitl/:id/approve`. The server returns 409
   * `duplicate_vote` if the same principal has already voted, and
   * 409 `already_rejected` if a concurrent reject crossed the line.
   */
  async approveHitlEscalation(
    escalationId: string,
    input: HitlApproveRequest = {},
  ): Promise<{ escalation: HitlEscalation; rateLimit: RateLimitState | null }> {
    const { body, rateLimit } = await this.post<HitlEscalation>(
      `/v1/hitl/${encodeURIComponent(escalationId)}/approve`,
      input,
    );
    return { escalation: body, rateLimit };
  }

  /**
   * Record a reject vote. Reject is short-circuit terminal — a single
   * reject closes the escalation regardless of how many approves have
   * accumulated.
   *
   * Calls `POST /v1/hitl/:id/reject`.
   */
  async rejectHitlEscalation(
    escalationId: string,
    input: HitlRejectRequest = {},
  ): Promise<{ escalation: HitlEscalation; rateLimit: RateLimitState | null }> {
    const { body, rateLimit } = await this.post<HitlEscalation>(
      `/v1/hitl/${encodeURIComponent(escalationId)}/reject`,
      input,
    );
    return { escalation: body, rateLimit };
  }

  /**
   * Re-route an open escalation to a higher tier. Bounded by the
   * escalation's `max_escalation_depth` — the server returns 409
   * `chain_exhausted` and applies the configured fallback decision
   * once the ceiling is hit.
   *
   * Calls `POST /v1/hitl/:id/escalate`.
   */
  async escalateHitlEscalation(
    escalationId: string,
    input: HitlEscalateRequest,
  ): Promise<{ escalation: HitlEscalation; rateLimit: RateLimitState | null }> {
    const { body, rateLimit } = await this.post<HitlEscalation>(
      `/v1/hitl/${encodeURIComponent(escalationId)}/escalate`,
      input,
    );
    return { escalation: body, rateLimit };
  }

  /**
   * Manually apply the escalation's `fallback_decision`. Useful for
   * admin recovery of a hung escalation when the cron sweeper hasn't
   * run yet, or to short-circuit a stuck flow during incident
   * response.
   *
   * Calls `POST /v1/hitl/:id/timeout`.
   */
  async timeoutHitlEscalation(
    escalationId: string,
  ): Promise<{ escalation: HitlEscalation; rateLimit: RateLimitState | null }> {
    const { body, rateLimit } = await this.post<HitlEscalation>(
      `/v1/hitl/${encodeURIComponent(escalationId)}/timeout`,
      {},
    );
    return { escalation: body, rateLimit };
  }

  /**
   * Run a named governance graph traversal query.
   *
   * Dispatches to `GET /v1/governance/graph/query?type=<queryType>`.
   * Each query type returns a different row shape — the return type
   * narrows automatically based on the literal `queryType` argument.
   *
   * `"user_approvals"` requires `params.actor_id` — the server returns
   * a 400 if it is absent.
   */
  async queryGovernanceGraph<T extends GovernanceGraphQueryType>(
    queryType: T,
    params: GovernanceGraphQueryParams = {},
  ): Promise<GovernanceGraphQueryResponse<T>> {
    const qs = new URLSearchParams({ type: queryType });
    if (params.actor_id) qs.set("actor_id", params.actor_id);
    const { body, rateLimit } = await this.get<{
      query_type: T;
      results: GovernanceGraphResultRow<T>[];
      org_id: string;
    }>("/v1/governance/graph/query", qs);
    return { ...body, rateLimit };
  }

  /**
   * Reconstruct the multi-system execution timeline for a specific incident.
   *
   * Calls `GET /v1/governance/timeline/incident/{incidentId}`. Backed
   * server-side by `reconstruct_incident_chains_v2()`, which fixes the
   * `executor_id → actor_id` bug that silently produced empty timelines
   * in the original function.
   *
   * Returns full execution rows including the §13.1 columns
   * (`delegation_chain_id`, `replay_of_execution_id`, `incident_id`,
   * `policy_version_id`, `bundle_version_id`) alongside the actor
   * timeline and evidence rows.
   */
  async getIncidentTimeline(incidentId: string): Promise<IncidentTimelineResponse> {
    if (!incidentId) {
      throw new AtlaSentError("incidentId is required", { code: "bad_request" });
    }
    const { body, rateLimit } = await this.get<
      Omit<IncidentTimelineResponse, "rateLimit">
    >(`/v1/governance/timeline/incident/${encodeURIComponent(incidentId)}`);
    return { ...body, rateLimit };
  }

  // ── Cross-Org Permission Negotiation ──────────────────────────────────────

  /**
   * Evaluate whether an identity in one org is permitted to perform an
   * action on a resource in another org.
   *
   * Calls `POST /v1/cross-org/permissions/check`.
   */
  async checkCrossOrgPermission(
    req: CrossOrgPermissionCheckRequest,
  ): Promise<CrossOrgPermissionCheckResult> {
    const { body } = await this.post<CrossOrgPermissionCheckResult>(
      "/v1/cross-org/permissions/check",
      req,
    );
    return body;
  }

  /**
   * List previous cross-org permission check results for the calling org.
   *
   * Calls `GET /v1/cross-org/permissions/checks`.
   */
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

  /**
   * List all anomaly response rules for the calling org.
   *
   * Calls `GET /v1/anomaly-response/rules`.
   */
  async listAnomalyResponseRules(): Promise<AnomalyResponseRule[]> {
    const { body } = await this.get<{ rules: AnomalyResponseRule[] }>(
      "/v1/anomaly-response/rules",
    );
    return body.rules ?? [];
  }

  /**
   * Create a new anomaly response rule.
   *
   * Calls `POST /v1/anomaly-response/rules`.
   */
  async createAnomalyResponseRule(
    req: CreateAnomalyResponseRuleRequest,
  ): Promise<AnomalyResponseRule> {
    const { body } = await this.post<AnomalyResponseRule>(
      "/v1/anomaly-response/rules",
      req,
    );
    return body;
  }

  /**
   * Update an existing anomaly response rule.
   *
   * Calls `POST /v1/anomaly-response/rules/:id/update`.
   */
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

  /**
   * Delete an anomaly response rule.
   *
   * Calls `POST /v1/anomaly-response/rules/:id/delete`.
   */
  async deleteAnomalyResponseRule(id: string): Promise<void> {
    await this.post<Record<string, unknown>>(
      `/v1/anomaly-response/rules/${encodeURIComponent(id)}/delete`,
      {},
    );
  }

  /**
   * Evaluate active rules against an anomaly score and execute any
   * matching automated responses.
   *
   * Calls `POST /v1/anomaly-response/trigger`.
   */
  async triggerAnomalyResponse(
    req: TriggerAnomalyResponseRequest,
  ): Promise<AnomalyResponseEvent[]> {
    const { body } = await this.post<{ events: AnomalyResponseEvent[] }>(
      "/v1/anomaly-response/trigger",
      req,
    );
    return body.events ?? [];
  }

  /**
   * List anomaly response events, optionally filtered by execution or limit.
   *
   * Calls `GET /v1/anomaly-response/events`.
   */
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

  /**
   * List budget exception requests, with optional status/policy/pagination filters.
   *
   * Calls `GET /v1/budget-exceptions`.
   */
  async listBudgetExceptions(
    params?: {
      status?: BudgetExceptionStatus;
      budget_policy_id?: string;
      limit?: number;
      offset?: number;
    },
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

  /**
   * Get a single budget exception request by ID.
   *
   * Calls `GET /v1/budget-exceptions/:id`.
   */
  async getBudgetException(id: string): Promise<BudgetExceptionRequest> {
    const { body } = await this.get<BudgetExceptionRequest>(
      `/v1/budget-exceptions/${encodeURIComponent(id)}`,
    );
    return body;
  }

  /**
   * Submit a new budget exception request.
   *
   * Calls `POST /v1/budget-exceptions`.
   */
  async createBudgetException(
    req: CreateBudgetExceptionRequest,
  ): Promise<BudgetExceptionRequest> {
    const { body } = await this.post<BudgetExceptionRequest>(
      "/v1/budget-exceptions",
      req,
    );
    return body;
  }

  /**
   * Approve a budget exception request.
   *
   * Calls `POST /v1/budget-exceptions/:id/approve`.
   */
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

  /**
   * Reject a budget exception request.
   *
   * Calls `POST /v1/budget-exceptions/:id/reject`.
   */
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

  /**
   * Cancel a budget exception request.
   *
   * Calls `POST /v1/budget-exceptions/:id/cancel`.
   */
  async cancelBudgetException(id: string): Promise<BudgetExceptionRequest> {
    const { body } = await this.post<BudgetExceptionRequest>(
      `/v1/budget-exceptions/${encodeURIComponent(id)}/cancel`,
      {},
    );
    return body;
  }

  // ── Regulatory Escalation Chain ───────────────────────────────────────────

  /**
   * List all regulatory authority levels for the calling org.
   *
   * Calls `GET /v1/regulatory/authority-levels`.
   */
  async listRegulatoryAuthorityLevels(): Promise<RegulatoryAuthorityLevel[]> {
    const { body } = await this.get<{ levels: RegulatoryAuthorityLevel[] }>(
      "/v1/regulatory/authority-levels",
    );
    return body.levels ?? [];
  }

  /**
   * Create a new regulatory authority level.
   *
   * Calls `POST /v1/regulatory/authority-levels`.
   */
  async createRegulatoryAuthorityLevel(
    req: Omit<RegulatoryAuthorityLevel, "id" | "org_id" | "created_at">,
  ): Promise<RegulatoryAuthorityLevel> {
    const { body } = await this.post<RegulatoryAuthorityLevel>(
      "/v1/regulatory/authority-levels",
      req,
    );
    return body;
  }

  /**
   * List regulatory escalations for the calling org.
   *
   * Calls `GET /v1/regulatory/escalations`.
   */
  async listRegulatoryEscalations(
    params?: {
      status?: RegulatoryEscalationStatus;
      subject_type?: string;
      subject_id?: string;
    },
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

  /**
   * Create a new regulatory escalation.
   *
   * Calls `POST /v1/regulatory/escalations`.
   */
  async createRegulatoryEscalation(
    req: CreateRegulatoryEscalationRequest,
  ): Promise<RegulatoryEscalation> {
    const { body } = await this.post<RegulatoryEscalation>(
      "/v1/regulatory/escalations",
      req,
    );
    return body;
  }

  /**
   * Acknowledge a regulatory escalation (confirm receipt).
   *
   * Calls `POST /v1/regulatory/escalations/:id/acknowledge`.
   */
  async acknowledgeRegulatoryEscalation(id: string): Promise<RegulatoryEscalation> {
    const { body } = await this.post<RegulatoryEscalation>(
      `/v1/regulatory/escalations/${encodeURIComponent(id)}/acknowledge`,
      {},
    );
    return body;
  }

  /**
   * Resolve a regulatory escalation with a documented resolution.
   *
   * Calls `POST /v1/regulatory/escalations/:id/resolve`.
   */
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

  /**
   * Override a regulatory escalation (bypass normal resolution path).
   *
   * Calls `POST /v1/regulatory/escalations/:id/override`.
   */
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

  /**
   * List all actions taken in response to a specific governance signal.
   *
   * Calls `GET /v1/governance/signals/:signal_id/actions`.
   */
  async listSignalActions(signal_id: string): Promise<GovernanceSignalAction[]> {
    const { body } = await this.get<{ actions: GovernanceSignalAction[] }>(
      `/v1/governance/signals/${encodeURIComponent(signal_id)}/actions`,
    );
    return body.actions ?? [];
  }

  /**
   * Record an action taken in response to a governance signal.
   *
   * Calls `POST /v1/governance/signals/:signal_id/actions`.
   */
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

  /**
   * Record the outcome of a previous signal action.
   *
   * Calls `POST /v1/governance/signals/:signal_id/actions/:action_id/outcome`.
   */
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

  /**
   * Get an aggregate summary of signal actions and outcomes for the calling org.
   *
   * Calls `GET /v1/governance/signals/actions/summary`.
   */
  async getSignalActionSummary(): Promise<SignalActionSummary> {
    const { body } = await this.get<SignalActionSummary>(
      "/v1/governance/signals/actions/summary",
    );
    return body;
  }

  // ── Cross-Org Impersonation ───────────────────────────────────────────────

  /**
   * List all active impersonation grants where the calling org is the grantor.
   *
   * Calls `GET /v1/cross-org/impersonation/grants`.
   */
  async listImpersonationGrants(): Promise<CrossOrgImpersonationGrant[]> {
    const { body } = await this.get<{ grants: CrossOrgImpersonationGrant[] }>(
      "/v1/cross-org/impersonation/grants",
    );
    return body.grants ?? [];
  }

  /**
   * Create a new cross-org impersonation grant.
   *
   * Calls `POST /v1/cross-org/impersonation/grants`.
   */
  async createImpersonationGrant(
    req: CreateImpersonationGrantRequest,
  ): Promise<CrossOrgImpersonationGrant> {
    const { body } = await this.post<CrossOrgImpersonationGrant>(
      "/v1/cross-org/impersonation/grants",
      req,
    );
    return body;
  }

  /**
   * Revoke an impersonation grant. Any tokens issued under the grant
   * become immediately invalid.
   *
   * Calls `POST /v1/cross-org/impersonation/grants/:id/revoke`.
   */
  async revokeImpersonationGrant(id: string): Promise<void> {
    await this.post<Record<string, unknown>>(
      `/v1/cross-org/impersonation/grants/${encodeURIComponent(id)}/revoke`,
      {},
    );
  }

  /**
   * Issue a short-lived impersonation token under an existing grant.
   *
   * Calls `POST /v1/cross-org/impersonation/grants/:grant_id/token`.
   */
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

  /**
   * Validate an impersonation token and retrieve its associated grant.
   *
   * Calls `POST /v1/cross-org/impersonation/validate`.
   */
  async validateImpersonationToken(
    token: string,
  ): Promise<ImpersonationValidationResult> {
    const { body } = await this.post<ImpersonationValidationResult>(
      "/v1/cross-org/impersonation/validate",
      { token },
    );
    return body;
  }
}

/**
 * Parse the server's `X-RateLimit-*` header triple into a typed
 * {@link RateLimitState}. Returns `null` when any of the three headers
 * is missing or unparseable — callers treat that as "the server didn't
 * emit rate-limit state" rather than "the window is empty".
 *
 * `X-RateLimit-Reset` is accepted as either unix-seconds (what the
 * AtlaSent edge functions emit today) or an ISO 8601 timestamp.
 */
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
    // Standard shape: unix seconds. 10-digit values are in the valid
    // range ~2001–2286 so this heuristic won't confuse a tiny
    // `remaining`-like number for an epoch.
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

/**
 * Translate an {@link AuditEventsQuery} into `URLSearchParams`. The
 * server expects snake_case keys (`actor_id`) and accepts
 * comma-joined values for `types`; numeric `limit` serializes via
 * `String(n)`. Undefined / empty fields are dropped so the query
 * string stays minimal.
 */
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

// ── SSE stream parser ─────────────────────────────────────────────────────────

/**
 * Parse an SSE `ReadableStream<Uint8Array>` into typed {@link StreamEvent}s.
 *
 * Hardening additions over the original:
 * - Per-event timeout: if no chunk arrives within `timeoutMs` (0 = disabled),
 *   throws {@link StreamTimeoutError}.
 * - Partial-JSON guard: wraps `JSON.parse` failures in {@link StreamParseError}
 *   rather than letting the raw `SyntaxError` escape.
 * - Calls `onEventId` whenever the server emits an `id:` field so the caller
 *   can track the `Last-Event-ID` for reconnection.
 * - Terminal detection: returns on `event: done` OR when a `decision` event
 *   carries `done: true` at the top level (server-side terminal signal).
 */
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

  /**
   * Read the next chunk from the reader, applying a per-read timeout when
   * `timeoutMs > 0`. Returns `{ done: true }` when the stream ends, throws
   * {@link StreamTimeoutError} on timeout.
   */
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
        // Network error mid-stream: surface as AtlaSentError(network) so the
        // caller's reconnection loop can catch and retry.
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
          // Streaming wire uses legacy {permitted, decision_id} shape;
          // normalise to canonical lowercase decision vocabulary.
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

          // Terminal: final decision OR inline done: true closes the stream.
          if (isFinal || d.done === true) return;
        } else if (eventType === "progress") {
          const p = parsed as Record<string, unknown>;
          yield { type: "progress", stage: String(p["stage"] ?? ""), ...p } satisfies StreamProgressEvent;
          // Server may signal terminal state via done: true on any event type.
          if ((p as Record<string, unknown>).done === true) return;
        } else {
          // Unknown event type: check for done: true as a terminal signal.
          if (
            parsed !== null &&
            typeof parsed === "object" &&
            (parsed as Record<string, unknown>).done === true
          ) {
            return;
          }
        }
        // Unknown event types skipped for forward compatibility.
      }
    }

    // Stream closed before an explicit `event: done`. If there's leftover
    // partial data in the buffer, it means the stream was cut mid-event.
    if (buf.trim().length > 0) {
      throw new StreamParseError(buf);
    }
  } finally {
    reader.releaseLock();
  }
}
