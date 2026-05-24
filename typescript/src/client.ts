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
import { PRODUCTION_DEPLOY_ACTION } from "./types.js";
import type {
  ApiKeySelfResponse,
  AtlaSentClientOptions,
  AuditEventsResult,
  AuditExportRequest,
  AuditExportResult,
  ConstraintTrace,
  DecisionCanonical,
  DecisionStreamEvent,
  DeployGateEvidence,
  DeployGateRequest,
  DeployGateResponse,
  BatchEvalItem,
  BatchEvalResponse,
  EvaluateBatchResultItem,
  EvaluatePreflightResponse,
  SubscribeDecisionsOptions,
  EvaluateRequest,
  EvaluateResponse,
  GetPermitResponse,
  ListPermitsRequest,
  ListPermitsResponse,
  PermitRecord,
  PermitValidResponse,
  RateLimitState,
  ReplayRequest,
  ReplayResponse,
  ReplayVarianceKind,
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
  GovernanceAgent,
  GovernanceAgentEvaluation,
  GovernanceAgentFinding,
  ListGovernanceAgentsResponse,
  ListGovernanceEvaluationsQuery,
  ListGovernanceEvaluationsResponse,
  ListGovernanceFindingsQuery,
  ListGovernanceFindingsResponse,
} from "./governanceAgents.js";
import type {
  HitlApprovalRecord,
  HitlApproveRequest,
  HitlChainHop,
  HitlCreateRequest,
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
  OrgRiskScore,
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
  RegulatoryEscalation,
  RegulatoryEscalationStatus,
  CreateRegulatoryEscalationRequest,
  RegulatoryAuthorityLevel,
} from "./regulatoryEscalation.js";
import type {
  SignalActionSummary,
  RecordSignalActionRequest,
  RecordSignalOutcomeRequest,
} from "./incentiveSignalFeedback.js";
import type {
  CrossOrgImpersonationGrant,
  ImpersonationToken,
  ImpersonationValidationResult,
  CreateImpersonationGrantRequest,
} from "./crossOrgImpersonation.js";

// ── SDK version (injected at build time) ─────────────────────────────────────

const SDK_VERSION = "2.7.0";

// ── Runtime detection ─────────────────────────────────────────────────────────

const IS_NODE =
  typeof process !== "undefined" &&
  typeof process.versions?.node === "string";

const USER_AGENT = IS_NODE
  ? `@atlasent/sdk/${SDK_VERSION} node/${process.versions.node}`
  : `@atlasent/sdk/${SDK_VERSION} browser`;

// ── Wire interfaces ───────────────────────────────────────────────────────────
//
// These are local to the module; callers see only the public SDK shapes.

/**
 * Wire shape of a successful response from `POST /v1-evaluate`.
 *
 * Canonical fields (atlasent-api PR #190):
 *   decision: "allow" | "deny" | "hold" | "escalate"
 *   permit_token?: string
 *   request_id?: string
 *   expires_at?: string
 *   denial?: { reason?, code? }
 *   constraint_trace?: unknown   (present only when ?include=constraint_trace)
 *
 * Legacy passthrough fields (for backward compat with older deployments):
 *   permitted?: boolean
 *   decision_id?: string
 *   reason?: string
 *   audit_hash?: string
 *   timestamp?: string
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
  matched_policy_id?: string;
}

/**
 * Wire shape for a single item returned by `POST /v1/evaluate/batch`.
 */
interface EvaluateBatchWire {
  index: number;
  decision?: string;
  decision_id?: string;
  permit_token?: string | null;
  reason?: string;
  audit_hash?: string;
  timestamp?: string;
  error?: string;
  message?: string;
}

/**
 * Wire envelope returned by `POST /v1/evaluate/batch`.
 */
interface BatchEvalWireEnvelope {
  batch_id: string;
  items: EvaluateBatchWire[];
  partial: boolean;
  replayed?: boolean;
}

/**
 * Wire shape of a response received from `POST /v1-verify-permit`.
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

interface ReplayWire {
  decision_id?: string;
  original_decision?: string;
  original_deny_code?: string;
  replay_decision?: string;
  replay_deny_code?: string;
  engine_version?: string;
  engine_version_kind?: string;
  accepts_replay?: boolean;
  variance?: string;
  envelope_verification?: string;
  replayed_at?: string;
  error?: string;
  message?: string;
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
      throw new AtlaSentError("apiKey is required and must be a non-empty string", {
        code: "bad_request",
      });
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://api.atlasent.io").replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 10_000;

    if (!("AbortSignal" in globalThis) || typeof AbortSignal.timeout !== "function") {
      throw new AtlaSentError(
        "AbortSignal.timeout is not available in this environment. " +
          "AtlaSentClient requires Chrome ≥ 103, Firefox ≥ 100, Safari ≥ 16, " +
          "Edge ≥ 103, or Node.js ≥ 17.3.",
        { code: "network" },
      );
    }

    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.userAgent = USER_AGENT;
    this.retryPolicy = mergePolicy(options.retryPolicy);
  }

  // ── Public methods ──────────────────────────────────────────────────────────

  /**
   * Request a policy decision for a given agent + action + context.
   *
   * Returns a typed {@link EvaluateResponse}. A policy DENY is NOT thrown —
   * check `response.decision` to branch. Only transport, auth, and rate-limit
   * failures throw {@link AtlaSentError}.
   */
  async evaluate(
    request: EvaluateRequest | LegacyEvaluateRequest | V2EvaluateRequest,
  ): Promise<EvaluateResponse> {
    const normalized = normalizeEvaluateRequest(request);

    const { body: wire, rateLimit } = await this.post<EvaluateWire>(
      "/v1-evaluate",
      normalized,
    );

    // Canonical decision: server now emits lowercase 4-value vocabulary.
    // Normalise legacy uppercase responses from older deployments.
    const rawDecision = wire.decision ?? (wire.permitted ? "allow" : "deny");
    const decision = rawDecision.toLowerCase() as DecisionCanonical;

    // Legacy decision_id / request_id unification.
    const evaluationId = wire.request_id ?? wire.decision_id ?? "";

    return {
      decision,
      decision_canonical: decision,
      evaluationId,
      permitId: evaluationId,
      permit: null,
      permitToken: wire.permit_token ?? null,
      reasons: wire.denial?.reason ? [wire.denial.reason] : wire.reason ? [wire.reason] : [],
      reason: wire.denial?.reason ?? wire.reason ?? "",
      auditHash: wire.audit_hash ?? "",
      timestamp: wire.timestamp ?? new Date().toISOString(),
      rateLimit,
    };
  }

  /**
   * Evaluate a batch of up to 100 requests in a single round-trip.
   *
   * Items are returned in input order. Per-item RPC failures surface as
   * `item.error` / `item.message`; a policy deny is `item.decision === "deny"`.
   * `partial: true` means at least one item errored at the RPC layer.
   */
  async evaluateBatch(requests: BatchEvalItem[]): Promise<BatchEvalResponse> {
    if (!Array.isArray(requests) || requests.length === 0) {
      throw new AtlaSentError("requests must be a non-empty array", {
        code: "bad_request",
      });
    }
    if (requests.length > 100) {
      throw new AtlaSentError("evaluateBatch supports at most 100 items per call", {
        code: "bad_request",
      });
    }

    const payload = {
      requests: requests.map((r) => ({
        action_type: r.action,
        actor_id: r.agent,
        context: r.context ?? {},
      })),
    };

    const { body: wire, rateLimit } = await this.post<BatchEvalWireEnvelope>(
      "/v1/evaluate/batch",
      payload,
    );

    const items: EvaluateBatchResultItem[] = (wire.items ?? []).map((item) => {
      if (item.error) {
        return { index: item.index, error: item.error, message: item.message };
      }
      const decision = item.decision
        ? (item.decision.toLowerCase() as DecisionCanonical)
        : undefined;
      return {
        index: item.index,
        decision,
        decisionId: item.decision_id,
        permitToken: item.permit_token ?? null,
        reason: item.reason,
        auditHash: item.audit_hash,
        timestamp: item.timestamp,
      };
    });

    return {
      batchId: wire.batch_id ?? "",
      items,
      partial: wire.partial ?? false,
      replayed: wire.replayed,
      rateLimit,
    };
  }

  /**
   * Evaluate with constraint trace — preflight mode.
   *
   * Calls `POST /v1-evaluate?include=constraint_trace`. The server returns
   * the same decision envelope as `evaluate()` plus a `constraint_trace`
   * block describing which policy stages fired and why. Use this to surface
   * _why_ a request would be denied **before** submitting it to an approval
   * queue, so trivially defective requests are rejected at submission time.
   *
   * `constraintTrace` is `null` when the server omits the field (older
   * atlasent-api deployments that don't support the query parameter).
   */
  async evaluatePreflight(
    request: EvaluateRequest,
  ): Promise<EvaluatePreflightResponse> {
    const normalized = normalizeEvaluateRequest(request);
    const query = new URLSearchParams({ include: "constraint_trace" });

    const { body: wire, rateLimit } = await this.post<EvaluateWire>(
      "/v1-evaluate",
      normalized,
      query,
    );

    const rawDecision = wire.decision ?? (wire.permitted ? "allow" : "deny");
    const decision = rawDecision.toLowerCase() as DecisionCanonical;
    const evaluationId = wire.request_id ?? wire.decision_id ?? "";

    const evaluation: EvaluateResponse = {
      decision,
      decision_canonical: decision,
      evaluationId,
      permitId: evaluationId,
      permit: null,
      permitToken: wire.permit_token ?? null,
      reasons: wire.denial?.reason ? [wire.denial.reason] : wire.reason ? [wire.reason] : [],
      reason: wire.denial?.reason ?? wire.reason ?? "",
      auditHash: wire.audit_hash ?? "",
      timestamp: wire.timestamp ?? new Date().toISOString(),
      rateLimit,
    };

    // constraint_trace is an opaque passthrough — typed as ConstraintTrace | null.
    const constraintTrace =
      wire.constraint_trace != null
        ? (wire.constraint_trace as ConstraintTrace)
        : null;

    return { evaluation, constraintTrace };
  }

  /**
   * Verify that a permit issued by a prior `evaluate()` call is still valid.
   *
   * @deprecated Use {@link verifyPermitById} — the canonical REST surface
   * (`POST /v1/permits/{id}/verify`) returns the unified verification
   * envelope plus the full PermitRecord. Will be removed in `@atlasent/sdk@3`.
   */
  async verifyPermit(request: VerifyPermitRequest): Promise<VerifyPermitResponse> {
    const body: Record<string, unknown> = {
      permit_token: request.permitId,
    };
    if (request.action) body["action_type"] = request.action;
    if (request.agent) body["actor_id"] = request.agent;
    if (request.environment) body["environment"] = request.environment;
    if (request.execution_hash) body["execution_hash"] = request.execution_hash;

    const { body: wire, rateLimit } = await this.post<VerifyPermitWire>(
      "/v1-verify-permit",
      body,
    );

    const verified = wire.valid ?? wire.verified ?? false;

    return {
      verified,
      outcome: wire.outcome ?? (verified ? "allow" : "deny"),
      permitHash: wire.permit_hash ?? "",
      timestamp: wire.timestamp ?? new Date().toISOString(),
      rateLimit,
    };
  }

  /**
   * Verify a permit by its canonical UUID — `POST /v1/permits/{id}/verify`.
   *
   * Returns the unified verification envelope (`valid`, `verification_type`,
   * `reason`, `verified_at`, `evidence`) plus the full PermitRecord at the
   * top level for backward compatibility.
   */
  async verifyPermitById(permitId: string): Promise<VerifyPermitByIdResponse> {
    const { body, rateLimit } = await this.post<VerifyPermitByIdResponse>(
      `/v1/permits/${permitId}/verify`,
      {},
    );
    return { ...body, rateLimit };
  }

  /**
   * Revoke a permit by its canonical UUID — `POST /v1/permits/{id}/revoke`.
   *
   * Returns the updated PermitRecord with `status === 'revoked'` and the
   * populated `revoked_at` / `revoked_by` / `revoke_reason` fields.
   */
  async revokePermitById(
    permitId: string,
    input?: RevokePermitByIdInput,
  ): Promise<RevokePermitByIdResponse> {
    const { body, rateLimit } = await this.post<{ permit: PermitRecord }>(
      `/v1/permits/${permitId}/revoke`,
      input?.reason ? { reason: input.reason } : {},
    );
    return { permit: body.permit, rateLimit };
  }

  /**
   * Revoke a permit by its ID.
   *
   * @deprecated Use {@link revokePermitById} — the canonical REST surface
   * (`POST /v1/permits/{id}/revoke`) returns the full updated PermitRecord.
   * Will be removed in `@atlasent/sdk@3`.
   */
  async revokePermit(request: RevokePermitRequest): Promise<RevokePermitResponse> {
    const body: Record<string, unknown> = { permit_token: request.permitId };
    if (request.reason) body["reason"] = request.reason;

    const { body: wire, rateLimit } = await this.post<{
      revoked?: boolean;
      permit_id?: string;
      revoked_at?: string;
      audit_hash?: string;
    }>("/v1-revoke-permit", body);

    return {
      revoked: wire.revoked ?? true,
      permitId: wire.permit_id ?? request.permitId,
      revokedAt: wire.revoked_at,
      auditHash: wire.audit_hash,
      rateLimit,
    };
  }

  /**
   * Retrieve a permit by its canonical UUID — `GET /v1/permits/{id}`.
   */
  async getPermit(permitId: string): Promise<{ permit: PermitRecord; rateLimit: RateLimitState | null }> {
    const { body, rateLimit } = await this.get<{ permit: PermitRecord }>(
      `/v1/permits/${permitId}`,
    );
    return { permit: body.permit, rateLimit };
  }

  /**
   * List permits with optional filters — `GET /v1/permits`.
   */
  async listPermits(request?: ListPermitsRequest): Promise<ListPermitsResponse> {
    const params = new URLSearchParams();
    if (request?.status) params.set("status", request.status);
    if (request?.actorId) params.set("actor_id", request.actorId);
    if (request?.actionType) params.set("action_type", request.actionType);
    if (request?.from) params.set("from", request.from);
    if (request?.to) params.set("to", request.to);
    if (request?.limit != null) params.set("limit", String(request.limit));
    if (request?.cursor) params.set("cursor", request.cursor);

    const { body, rateLimit } = await this.get<{
      permits: PermitRecord[];
      total: number;
      next_cursor?: string;
    }>("/v1/permits", params);

    return {
      permits: body.permits ?? [],
      total: body.total ?? 0,
      nextCursor: body.next_cursor,
      rateLimit,
    };
  }

  /**
   * Check if a permit is currently valid — `GET /v1/permits/{id}/valid`.
   *
   * Lightweight heartbeat check for in-flight permit guards. Returns only
   * the fields needed to abort mid-execution if the permit was revoked.
   */
  async checkPermitValid(permitId: string): Promise<{ valid: boolean; status: string; revokedAt?: string; revocationId?: string }> {
    const { body } = await this.get<{
      valid: boolean;
      status: string;
      revoked_at?: string;
      revocation_id?: string;
    }>(`/v1/permits/${permitId}/valid`);
    return {
      valid: body.valid,
      status: body.status,
      revokedAt: body.revoked_at,
      revocationId: body.revocation_id,
    };
  }

  /**
   * Self-introspect the API key this client was constructed with.
   *
   * Calls `GET /v1/api-key-self`. Returns key metadata without exposing
   * the raw key value — safe to surface in operator dashboards.
   */
  async keySelf(): Promise<ApiKeySelfResponse> {
    const { body: wire, rateLimit } = await this.get<{
      key_id: string;
      organization_id: string;
      environment: string;
      scopes: string[];
      allowed_cidrs: string[] | null;
      rate_limit_per_minute: number;
      client_ip: string | null;
      expires_at: string | null;
    }>("/v1/api-key-self");

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
   * List audit events — `GET /v1-audit/events`.
   */
  async listAuditEvents(query?: AuditEventsQuery): Promise<AuditEventsResult> {
    const params = new URLSearchParams();
    if (query?.types) params.set("types", query.types);
    if (query?.actor_id) params.set("actor_id", query.actor_id);
    if (query?.from) params.set("from", query.from);
    if (query?.to) params.set("to", query.to);
    if (query?.limit != null) params.set("limit", String(query.limit));
    if (query?.cursor) params.set("cursor", query.cursor);

    const { body, rateLimit } = await this.get<AuditEventsPage>(
      "/v1-audit/events",
      params,
    );
    return { ...body, rateLimit };
  }

  /**
   * Create a signed audit export bundle — `POST /v1-audit/exports`.
   *
   * The returned bundle can be verified offline with
   * `verifyAuditBundle(bundle, keys)`.
   */
  async createAuditExport(request?: AuditExportRequest): Promise<AuditExportResult> {
    const { body, rateLimit } = await this.post<AuditExport>(
      "/v1-audit/exports",
      request ?? {},
    );
    return { ...body, rateLimit };
  }

  /**
   * Canonical Deploy Gate V1 flow.
   *
   * Calls `evaluate()` then `verifyPermit()` in sequence. Returns a typed
   * {@link DeployGateResponse} with `allowed: true` only when both steps
   * succeed. Fail-closed: any error or non-allow decision returns
   * `allowed: false` with a human-readable `reason`.
   */
  async deployGate(request?: DeployGateRequest): Promise<DeployGateResponse> {
    const agent = request?.agent ?? "ci-deploy-bot";
    const action = request?.action ?? PRODUCTION_DEPLOY_ACTION;
    const context = request?.context ?? {};

    let evalResponse: EvaluateResponse;
    try {
      evalResponse = await this.evaluate({ agent, action, context });
    } catch (err) {
      const reason =
        err instanceof AtlaSentError ? err.message : "evaluate() failed";
      return {
        allowed: false,
        reason,
        evidence: {},
      };
    }

    if (evalResponse.decision !== "allow") {
      return {
        allowed: false,
        evaluation: evalResponse,
        reason: evalResponse.reason || `decision: ${evalResponse.decision}`,
        evidence: { auditHash: evalResponse.auditHash },
      };
    }

    let verifyResponse;
    try {
      verifyResponse = await this.verifyPermit({
        permitId: evalResponse.permitId,
        action,
        agent,
        context: context as Record<string, unknown>,
      });
    } catch (err) {
      const reason =
        err instanceof AtlaSentError ? err.message : "verifyPermit() failed";
      return {
        allowed: false,
        evaluation: evalResponse,
        reason,
        evidence: { auditHash: evalResponse.auditHash },
      };
    }

    if (!verifyResponse.verified) {
      return {
        allowed: false,
        evaluation: evalResponse,
        verification: verifyResponse,
        reason: "permit verification failed",
        evidence: {
          auditHash: evalResponse.auditHash,
          permitHash: verifyResponse.permitHash,
          verifiedAt: verifyResponse.timestamp,
        },
      };
    }

    return {
      allowed: true,
      evaluation: evalResponse,
      verification: verifyResponse,
      reason: "authorized",
      evidence: {
        permitId: evalResponse.permitId,
        auditHash: evalResponse.auditHash,
        permitHash: verifyResponse.permitHash,
        verifiedAt: verifyResponse.timestamp,
      },
    };
  }

  /**
   * Stream policy decisions via Server-Sent Events.
   *
   * Yields {@link StreamDecisionEvent} and {@link StreamProgressEvent}
   * objects as the server emits them. The generator terminates when the
   * server signals completion (via `isFinal: true` on a decision event or
   * `done: true` on any event), or throws on transport / parse errors.
   */
  async *protectStream(
    request: EvaluateRequest,
    options?: StreamOptions,
  ): AsyncGenerator<StreamEvent> {
    yield* protectStreamImpl(
      this.baseUrl,
      this.apiKey,
      this.userAgent,
      this.fetchImpl,
      request,
      options,
    );
  }

  /**
   * Subscribe to the decisions event stream — `GET /v1/decisions/stream`.
   *
   * Yields {@link DecisionStreamEvent} objects in real-time as decisions
   * are recorded. The generator terminates when the server closes the stream
   * (e.g. after `maxSeconds`) or when the caller cancels via `options.signal`.
   */
  async *subscribeDecisions(
    options?: SubscribeDecisionsOptions,
  ): AsyncGenerator<DecisionStreamEvent> {
    const params = new URLSearchParams();
    if (options?.types?.length) params.set("types", options.types.join(","));
    if (options?.actorId) params.set("actor_id", options.actorId);
    if (options?.lastEventId) params.set("last_event_id", options.lastEventId);
    if (options?.maxSeconds != null) params.set("max_seconds", String(options.maxSeconds));

    const url = `${this.baseUrl}/v1/decisions/stream?${params}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "text/event-stream",
      "User-Agent": this.userAgent,
    };

    const fetchOpts: RequestInit = { headers };
    if (options?.signal) fetchOpts.signal = options.signal;

    let resp: Response;
    try {
      resp = await this.fetchImpl(url, fetchOpts);
    } catch (err) {
      throw new AtlaSentError("Network error on decisions stream", {
        code: "network",
      });
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new AtlaSentError(text || `HTTP ${resp.status}`, {
        code: resp.status === 401 ? "invalid_api_key" : "server_error",
        status: resp.status,
      });
    }

    if (!resp.body) {
      throw new AtlaSentError("Response body is null on decisions stream", {
        code: "bad_response",
      });
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        const events = buf.split(/\n\n/);
        buf = events.pop() ?? "";

        for (const raw of events) {
          if (!raw.trim()) continue;

          let eventId: string | undefined;
          let eventType = "message";
          const dataLines: string[] = [];

          for (const line of raw.split("\n")) {
            if (line.startsWith("id:")) {
              eventId = line.slice(3).trim();
            } else if (line.startsWith("event:")) {
              eventType = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              dataLines.push(line.slice(5).trim());
            }
          }

          const data = dataLines.join("\n");

          if (eventType === "heartbeat" || eventType === "ping") {
            yield { type: "heartbeat", id: eventId };
            continue;
          }

          if (eventType === "session_end") {
            yield { type: "session_end", id: eventId };
            return;
          }

          if (!data) continue;

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }

          yield {
            id: eventId ?? (parsed["id"] as string | undefined),
            type: eventType,
            decision: parsed["decision"] as DecisionCanonical | undefined,
            actorId: parsed["actor_id"] as string | undefined,
            resourceType: parsed["resource_type"] as string | undefined,
            resourceId: parsed["resource_id"] as string | undefined,
            payload: parsed["payload"] as Record<string, unknown> | undefined,
            hash: parsed["hash"] as string | undefined,
            previousHash: parsed["previous_hash"] as string | undefined,
            occurredAt: parsed["occurred_at"] as string | undefined,
          } satisfies DecisionStreamEvent;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // ── HITL escalation methods ───────────────────────────────────────────────

  /**
   * Create a new HITL escalation — `POST /v1/hitl/escalations`.
   */
  async createHitlEscalation(request: HitlCreateRequest): Promise<HitlEscalation> {
    const { body } = await this.post<{ escalation: HitlEscalation }>(
      "/v1/hitl/escalations",
      request,
    );
    return body.escalation;
  }

  /**
   * List HITL escalations — `GET /v1/hitl/escalations`.
   */
  async listHitlEscalations(
    query?: ListHitlEscalationsRequest,
  ): Promise<ListHitlEscalationsResponse> {
    const params = new URLSearchParams();
    if (query?.status) params.set("status", query.status);
    if (query?.actor_id) params.set("actor_id", query.actor_id);
    if (query?.limit != null) params.set("limit", String(query.limit));
    if (query?.cursor) params.set("cursor", query.cursor);
    const { body } = await this.get<ListHitlEscalationsResponse>(
      "/v1/hitl/escalations",
      params,
    );
    return body;
  }

  /**
   * Approve a HITL escalation — `POST /v1/hitl/escalations/{id}/approve`.
   */
  async approveHitlEscalation(
    escalationId: string,
    request: HitlApproveRequest,
  ): Promise<HitlApprovalRecord> {
    const { body } = await this.post<{ approval: HitlApprovalRecord }>(
      `/v1/hitl/escalations/${escalationId}/approve`,
      request,
    );
    return body.approval;
  }

  /**
   * Reject a HITL escalation — `POST /v1/hitl/escalations/{id}/reject`.
   */
  async rejectHitlEscalation(
    escalationId: string,
    request: HitlRejectRequest,
  ): Promise<HitlEscalation> {
    const { body } = await this.post<{ escalation: HitlEscalation }>(
      `/v1/hitl/escalations/${escalationId}/reject`,
      request,
    );
    return body.escalation;
  }

  /**
   * Escalate a HITL escalation to the next tier.
   */
  async escalateHitlEscalation(
    escalationId: string,
    request: HitlEscalateRequest,
  ): Promise<HitlChainHop> {
    const { body } = await this.post<{ hop: HitlChainHop }>(
      `/v1/hitl/escalations/${escalationId}/escalate`,
      request,
    );
    return body.hop;
  }

  // ── Governance Graph methods ──────────────────────────────────────────────

  /**
   * Query the governance graph — `POST /v1/governance/graph/query`.
   */
  async queryGovernanceGraph(
    queryType: GovernanceGraphQueryType,
    params: GovernanceGraphQueryParams,
  ): Promise<GovernanceGraphResultRow[]> {
    const { body } = await this.post<GovernanceGraphQueryResponse>(
      "/v1/governance/graph/query",
      { query_type: queryType, params },
    );
    return body.rows ?? [];
  }

  // ── Incident Reconstruction methods ──────────────────────────────────────

  /**
   * Get the incident timeline for a given change — `GET /v1/governance/incidents/{changeId}/timeline`.
   */
  async getIncidentTimeline(changeId: string): Promise<IncidentTimelineResponse> {
    const { body } = await this.get<IncidentTimelineResponse>(
      `/v1/governance/incidents/${changeId}/timeline`,
    );
    return body;
  }

  // ── Connector Management methods ──────────────────────────────────────────

  /**
   * List installed connectors — `GET /v1/connectors`.
   */
  async listConnectors(connectorType?: ConnectorType): Promise<ListConnectorsResponse> {
    const params = new URLSearchParams();
    if (connectorType) params.set("type", connectorType);
    const { body } = await this.get<ListConnectorsResponse>("/v1/connectors", params);
    return body;
  }

  /**
   * Install a connector — `POST /v1/connectors`.
   */
  async installConnector(input: InstallConnectorInput): Promise<InstallConnectorResponse> {
    const { body } = await this.post<InstallConnectorResponse>("/v1/connectors", input);
    return body;
  }

  /**
   * Authenticate a connector — `POST /v1/connectors/{id}/authenticate`.
   */
  async authenticateConnector(
    connectorId: string,
    input: AuthenticateConnectorInput,
  ): Promise<AuthenticateConnectorResponse> {
    const { body } = await this.post<AuthenticateConnectorResponse>(
      `/v1/connectors/${connectorId}/authenticate`,
      input,
    );
    return body;
  }

  /**
   * Sync a connector — `POST /v1/connectors/{id}/sync`.
   */
  async syncConnector(connectorId: string): Promise<SyncConnectorResponse> {
    const { body } = await this.post<SyncConnectorResponse>(
      `/v1/connectors/${connectorId}/sync`,
      {},
    );
    return body;
  }

  /**
   * Revoke a connector — `POST /v1/connectors/{id}/revoke`.
   */
  async revokeConnector(connectorId: string): Promise<RevokeConnectorResponse> {
    const { body } = await this.post<RevokeConnectorResponse>(
      `/v1/connectors/${connectorId}/revoke`,
      {},
    );
    return body;
  }

  /**
   * Rotate credentials for a connector — `POST /v1/connectors/{id}/rotate-credentials`.
   */
  async rotateConnectorCredentials(connectorId: string): Promise<RotateCredentialsResponse> {
    const { body } = await this.post<RotateCredentialsResponse>(
      `/v1/connectors/${connectorId}/rotate-credentials`,
      {},
    );
    return body;
  }

  /**
   * List enforcement policies — `GET /v1/connectors/{id}/enforcement-policies`.
   */
  async listEnforcementPolicies(
    connectorId: string,
  ): Promise<ListEnforcementPoliciesResponse> {
    const { body } = await this.get<ListEnforcementPoliciesResponse>(
      `/v1/connectors/${connectorId}/enforcement-policies`,
    );
    return body;
  }

  /**
   * Upsert an enforcement policy — `PUT /v1/connectors/{id}/enforcement-policies`.
   */
  async upsertEnforcementPolicy(
    connectorId: string,
    input: UpsertEnforcementPolicyInput,
  ): Promise<UpsertEnforcementPolicyResponse> {
    const { body } = await this.post<UpsertEnforcementPolicyResponse>(
      `/v1/connectors/${connectorId}/enforcement-policies`,
      input,
    );
    return body;
  }

  // ── Org Risk Graph methods ────────────────────────────────────────────────

  /**
   * Compute an org risk score on demand — `POST /v1/org-risk/compute`.
   */
  async computeOrgRisk(options?: ComputeOrgRiskOptions): Promise<ComputeOrgRiskResponse> {
    const { body } = await this.post<ComputeOrgRiskResponse>(
      "/v1/org-risk/compute",
      options ?? {},
    );
    return body;
  }

  /**
   * Get the latest org risk score — `GET /v1/org-risk/latest`.
   */
  async getLatestOrgRisk(): Promise<GetLatestOrgRiskResponse> {
    const { body } = await this.get<GetLatestOrgRiskResponse>("/v1/org-risk/latest");
    return body;
  }

  /**
   * List org risk score history — `GET /v1/org-risk/history`.
   */
  async listOrgRiskHistory(limit?: number): Promise<ListOrgRiskHistoryResponse> {
    const params = new URLSearchParams();
    if (limit != null) params.set("limit", String(limit));
    const { body } = await this.get<ListOrgRiskHistoryResponse>(
      "/v1/org-risk/history",
      params,
    );
    return body;
  }

  // ── Cross-Org Permission Negotiation methods ──────────────────────────────

  /**
   * Check a cross-org permission — `POST /v1/cross-org/permissions/check`.
   */
  async checkCrossOrgPermission(
    request: CrossOrgPermissionCheckRequest,
  ): Promise<CrossOrgPermissionCheckResult> {
    const { body } = await this.post<CrossOrgPermissionCheckResult>(
      "/v1/cross-org/permissions/check",
      request,
    );
    return body;
  }

  /**
   * List cross-org permissions — `GET /v1/cross-org/permissions`.
   */
  async listCrossOrgPermissions(
    params?: CrossOrgPermissionCheckListParams,
  ): Promise<CrossOrgPermissionCheckResult[]> {
    const urlParams = new URLSearchParams();
    if (params?.target_org_id) urlParams.set("target_org_id", params.target_org_id);
    if (params?.action_type) urlParams.set("action_type", params.action_type);
    const { body } = await this.get<{ permissions: CrossOrgPermissionCheckResult[] }>(
      "/v1/cross-org/permissions",
      urlParams,
    );
    return body.permissions ?? [];
  }

  // ── Anomaly Response methods ──────────────────────────────────────────────

  /**
   * List anomaly response rules — `GET /v1/anomaly-response/rules`.
   */
  async listAnomalyResponseRules(): Promise<AnomalyResponseRule[]> {
    const { body } = await this.get<{ rules: AnomalyResponseRule[] }>(
      "/v1/anomaly-response/rules",
    );
    return body.rules ?? [];
  }

  /**
   * Create an anomaly response rule — `POST /v1/anomaly-response/rules`.
   */
  async createAnomalyResponseRule(
    request: CreateAnomalyResponseRuleRequest,
  ): Promise<AnomalyResponseRule> {
    const { body } = await this.post<{ rule: AnomalyResponseRule }>(
      "/v1/anomaly-response/rules",
      request,
    );
    return body.rule;
  }

  /**
   * Trigger anomaly response — `POST /v1/anomaly-response/trigger`.
   */
  async triggerAnomalyResponse(
    request: TriggerAnomalyResponseRequest,
  ): Promise<AnomalyResponseEvent> {
    const { body } = await this.post<{ event: AnomalyResponseEvent }>(
      "/v1/anomaly-response/trigger",
      request,
    );
    return body.event;
  }

  // ── Budget Exception methods ──────────────────────────────────────────────

  /**
   * List budget exception requests — `GET /v1/budget-exceptions`.
   */
  async listBudgetExceptions(status?: BudgetExceptionStatus): Promise<BudgetExceptionRequest[]> {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    const { body } = await this.get<{ exceptions: BudgetExceptionRequest[] }>(
      "/v1/budget-exceptions",
      params,
    );
    return body.exceptions ?? [];
  }

  /**
   * Create a budget exception request — `POST /v1/budget-exceptions`.
   */
  async createBudgetException(
    request: CreateBudgetExceptionRequest,
  ): Promise<BudgetExceptionRequest> {
    const { body } = await this.post<{ exception: BudgetExceptionRequest }>(
      "/v1/budget-exceptions",
      request,
    );
    return body.exception;
  }

  /**
   * Approve a budget exception — `POST /v1/budget-exceptions/{id}/approve`.
   */
  async approveBudgetException(
    exceptionId: string,
    request: ApproveBudgetExceptionRequest,
  ): Promise<BudgetExceptionRequest> {
    const { body } = await this.post<{ exception: BudgetExceptionRequest }>(
      `/v1/budget-exceptions/${exceptionId}/approve`,
      request,
    );
    return body.exception;
  }

  // ── Regulatory Escalation methods ─────────────────────────────────────────

  /**
   * List regulatory escalations — `GET /v1/regulatory-escalations`.
   */
  async listRegulatoryEscalations(
    status?: RegulatoryEscalationStatus,
    authorityLevel?: RegulatoryAuthorityLevel,
  ): Promise<RegulatoryEscalation[]> {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (authorityLevel) params.set("authority_level", authorityLevel);
    const { body } = await this.get<{ escalations: RegulatoryEscalation[] }>(
      "/v1/regulatory-escalations",
      params,
    );
    return body.escalations ?? [];
  }

  /**
   * Create a regulatory escalation — `POST /v1/regulatory-escalations`.
   */
  async createRegulatoryEscalation(
    request: CreateRegulatoryEscalationRequest,
  ): Promise<RegulatoryEscalation> {
    const { body } = await this.post<{ escalation: RegulatoryEscalation }>(
      "/v1/regulatory-escalations",
      request,
    );
    return body.escalation;
  }

  // ── Incentive Signal Feedback methods ─────────────────────────────────────

  /**
   * List signal action summaries — `GET /v1/incentive-signals`.
   */
  async listSignalActions(limit?: number): Promise<SignalActionSummary[]> {
    const params = new URLSearchParams();
    if (limit != null) params.set("limit", String(limit));
    const { body } = await this.get<{ signals: SignalActionSummary[] }>(
      "/v1/incentive-signals",
      params,
    );
    return body.signals ?? [];
  }

  /**
   * Record a signal action — `POST /v1/incentive-signals/actions`.
   */
  async recordSignalAction(request: RecordSignalActionRequest): Promise<SignalActionSummary> {
    const { body } = await this.post<{ signal: SignalActionSummary }>(
      "/v1/incentive-signals/actions",
      request,
    );
    return body.signal;
  }

  /**
   * Record a signal outcome — `POST /v1/incentive-signals/outcomes`.
   */
  async recordSignalOutcome(request: RecordSignalOutcomeRequest): Promise<SignalActionSummary> {
    const { body } = await this.post<{ signal: SignalActionSummary }>(
      "/v1/incentive-signals/outcomes",
      request,
    );
    return body.signal;
  }

  // ── Cross-Org Impersonation methods ──────────────────────────────────────

  /**
   * Create a cross-org impersonation grant — `POST /v1/cross-org/impersonation/grants`.
   */
  async createImpersonationGrant(
    request: CreateImpersonationGrantRequest,
  ): Promise<CrossOrgImpersonationGrant> {
    const { body } = await this.post<{ grant: CrossOrgImpersonationGrant }>(
      "/v1/cross-org/impersonation/grants",
      request,
    );
    return body.grant;
  }

  /**
   * Exchange an impersonation grant for a token — `POST /v1/cross-org/impersonation/tokens`.
   */
  async exchangeImpersonationGrant(grantId: string): Promise<ImpersonationToken> {
    const { body } = await this.post<{ token: ImpersonationToken }>(
      "/v1/cross-org/impersonation/tokens",
      { grant_id: grantId },
    );
    return body.token;
  }

  /**
   * Validate an impersonation token — `POST /v1/cross-org/impersonation/validate`.
   */
  async validateImpersonationToken(token: string): Promise<ImpersonationValidationResult> {
    const { body } = await this.post<ImpersonationValidationResult>(
      "/v1/cross-org/impersonation/validate",
      { token },
    );
    return body;
  }

  // ── Governance Agent methods ──────────────────────────────────────────────

  /**
   * List governance agents — `GET /v1/governance/agents`.
   */
  async listGovernanceAgents(): Promise<GovernanceAgent[]> {
    const { body } = await this.get<ListGovernanceAgentsResponse>(
      "/v1/governance/agents",
    );
    return [...(body.agents ?? [])];
  }

  /**
   * List governance findings — `GET /v1/governance/findings`.
   */
  async listGovernanceFindings(
    query: ListGovernanceFindingsQuery,
  ): Promise<GovernanceAgentFinding[]> {
    if (!query?.change_id) {
      throw new AtlaSentError("change_id is required", { code: "bad_request" });
    }
    const params = new URLSearchParams({ change_id: query.change_id });
    if (query.agent_slug) params.set("agent_slug", query.agent_slug);
    const { body } = await this.get<ListGovernanceFindingsResponse>(
      "/v1/governance/findings",
      params,
    );
    return [...(body.findings ?? [])];
  }

  /**
   * List governance evaluations — `GET /v1/governance/evaluations`.
   */
  async listGovernanceEvaluations(
    query: ListGovernanceEvaluationsQuery,
  ): Promise<GovernanceAgentEvaluation[]> {
    if (!query?.change_id) {
      throw new AtlaSentError("change_id is required", { code: "bad_request" });
    }
    const params = new URLSearchParams({ change_id: query.change_id });
    if (query.agent_slug) params.set("agent_slug", query.agent_slug);
    const { body } = await this.get<ListGovernanceEvaluationsResponse>(
      "/v1/governance/evaluations",
      params,
    );
    return [...(body.evaluations ?? [])];
  }

  /**
   * Re-evaluate a recorded decision against its pinned policy bundle and engine
   * version (ADR-015 Phase C / POLICY_PARITY_CONTRACT.md §Replay).
   *
   * Calls `POST /v1/decisions/:id/replay`. The server re-evaluates with the
   * bundle and engine version recorded at decision time — no side effects (audit
   * chain writes, permit issuance, and webhooks are suppressed per ADR-016).
   *
   * The SDK is the third parity runtime in `POLICY_PARITY_CONTRACT.md` and joins
   * the `@atlasent/contract-parity` conformance vector suite on landing.
   *
   * @throws {AtlaSentError} For transport, auth, or unexpected server errors.
   *   Does NOT throw for the six canonical variance kinds — those are returned
   *   via {@link ReplayResponse.varianceKind} so callers can branch deterministically.
   */
  async replay(request: ReplayRequest): Promise<ReplayResponse> {
    const path = `/v1/decisions/${request.evaluationId}/replay`;
    let wireBody: ReplayWire;
    let rateLimit: RateLimitState | null;
    try {
      const result = await this.post<ReplayWire>(path, {});
      wireBody = result.body;
      rateLimit = result.rateLimit;
    } catch (err) {
      // 409 replay_not_eligible — map to ENGINE_DRIFT or BUNDLE_MISSING so
      // callers can branch on varianceKind without catching an exception.
      if (err instanceof AtlaSentError && err.status === 409) {
        const msg = err.message ?? "";
        const varianceKind: ReplayVarianceKind = msg.includes("bundle")
          ? "BUNDLE_MISSING"
          : "ENGINE_DRIFT";
        return {
          decisionId: request.evaluationId,
          varianceKind,
          originalDecision: "deny",
          acceptsReplay: false,
          replayedAt: new Date().toISOString(),
          rateLimit: null,
        };
      }
      throw err;
    }

    const rawVariance = wireBody.variance ?? "";
    const varianceKind: ReplayVarianceKind =
      rawVariance === "NONE"
        ? "NONE"
        : rawVariance === "DECISION_CHANGED"
          ? "POLICY_DRIFT"
          : rawVariance === "ENVELOPE_DRIFT"
            ? "ENVELOPE_DRIFT"
            : rawVariance === "CHAIN_TAMPER"
              ? "CHAIN_TAMPER"
              : rawVariance === "BUNDLE_MISSING"
                ? "BUNDLE_MISSING"
                : rawVariance === "ENGINE_DRIFT"
                  ? "ENGINE_DRIFT"
                  : "NONE";

    const originalDecision = (
      (wireBody.original_decision ?? "deny").toLowerCase()
    ) as DecisionCanonical;
    const replayedDecision = wireBody.replay_decision
      ? (wireBody.replay_decision.toLowerCase() as DecisionCanonical)
      : undefined;

    const out: ReplayResponse = {
      decisionId: wireBody.decision_id ?? request.evaluationId,
      varianceKind,
      originalDecision,
      acceptsReplay: wireBody.accepts_replay ?? true,
      replayedAt: wireBody.replayed_at ?? new Date().toISOString(),
      rateLimit,
    };
    if (wireBody.original_deny_code) out.originalDenyCode = wireBody.original_deny_code;
    if (replayedDecision !== undefined) out.replayedDecision = replayedDecision;
    if (wireBody.replay_deny_code) out.replayedDenyCode = wireBody.replay_deny_code;
    if (wireBody.engine_version) out.engineVersion = wireBody.engine_version;
    if (wireBody.engine_version_kind) out.engineVersionKind = wireBody.engine_version_kind;
    if (wireBody.envelope_verification) out.envelopeVerification = wireBody.envelope_verification;
    return out;
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: URLSearchParams,
  ): Promise<{ body: T; rateLimit: RateLimitState | null }> {
    const url = query?.toString()
      ? `${this.baseUrl}${path}?${query}`
      : `${this.baseUrl}${path}`;

    const requestId = crypto.randomUUID();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": this.userAgent,
      "X-Request-ID": requestId,
    };

    const fetchOpts: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (body !== undefined) {
      fetchOpts.body = JSON.stringify(body);
    }

    let attempt = 0;
    let lastError: unknown;

    while (true) {
      attempt++;
      try {
        let resp: Response;
        try {
          resp = await this.fetchImpl(url, fetchOpts);
        } catch (fetchErr) {
          const isTimeout =
            fetchErr instanceof Error &&
            (fetchErr.name === "TimeoutError" || fetchErr.name === "AbortError");
          const code: AtlaSentErrorCode = isTimeout ? "timeout" : "network";
          const err = new AtlaSentError(
            isTimeout ? `Request timed out after ${this.timeoutMs}ms` : "Network error",
            { code, requestId },
          );
          if (!isRetryable(err) || !hasAttemptsLeft(attempt, this.retryPolicy)) {
            throw err;
          }
          lastError = err;
          await sleep(computeBackoffMs(attempt, this.retryPolicy));
          continue;
        }

        const rateLimit = parseRateLimit(resp.headers);

        // 429 rate-limited
        if (resp.status === 429) {
          const retryAfterMs = parseRetryAfter(resp.headers);
          const err = new AtlaSentError("Rate limited", {
            code: "rate_limited",
            status: 429,
            retryAfterMs,
            requestId,
          });
          if (!hasAttemptsLeft(attempt, this.retryPolicy)) throw err;
          lastError = err;
          await sleep(retryAfterMs ?? computeBackoffMs(attempt, this.retryPolicy));
          continue;
        }

        // Non-2xx
        if (!resp.ok) {
          let errorBody: { error?: string; message?: string } = {};
          const text = await resp.text().catch(() => "");
          try {
            errorBody = JSON.parse(text);
          } catch {
            // not JSON — use raw text as message
          }
          const code = mapStatusToCode(resp.status, errorBody.error);
          const err = new AtlaSentError(
            errorBody.message ?? errorBody.error ?? `HTTP ${resp.status}`,
            { code, status: resp.status, requestId },
          );
          if (!isRetryable(err) || !hasAttemptsLeft(attempt, this.retryPolicy)) {
            throw err;
          }
          lastError = err;
          await sleep(computeBackoffMs(attempt, this.retryPolicy));
          continue;
        }

        // 2xx — parse JSON
        let parsed: T;
        const text = await resp.text().catch(() => null);
        if (!text) {
          const err = new AtlaSentError("Empty response body from AtlaSent API", {
            code: "bad_response",
            requestId,
          });
          if (!isRetryable(err) || !hasAttemptsLeft(attempt, this.retryPolicy)) {
            throw err;
          }
          lastError = err;
          await sleep(computeBackoffMs(attempt, this.retryPolicy));
          continue;
        }
        try {
          parsed = JSON.parse(text) as T;
        } catch {
          const err = new AtlaSentError("Invalid JSON in AtlaSent API response", {
            code: "bad_response",
            requestId,
          });
          if (!isRetryable(err) || !hasAttemptsLeft(attempt, this.retryPolicy)) {
            throw err;
          }
          lastError = err;
          await sleep(computeBackoffMs(attempt, this.retryPolicy));
          continue;
        }

        return { body: parsed, rateLimit };
      } catch (err) {
        if (err instanceof AtlaSentError) throw err;
        throw new AtlaSentError("Unexpected error during request", {
          code: "network",
          requestId,
        });
      }
    }

    // TypeScript requires this — the while(true) loop above always throws or returns.
    throw lastError ?? new AtlaSentError("Unknown error", { code: "network" });
  }

  private async post<T>(
    path: string,
    body: unknown,
    query?: URLSearchParams,
  ): Promise<{ body: T; rateLimit: RateLimitState | null }> {
    return this.request<T>("POST", path, body, query);
  }

  private async get<T>(
    path: string,
    query?: URLSearchParams,
  ): Promise<{ body: T; rateLimit: RateLimitState | null }> {
    return this.request<T>("GET", path, undefined, query);
  }
}

/**
 * Parse the server's `X-RateLimit-*` header triple into a typed
 * {@link RateLimitState}. Returns `null` when any of the three headers
 * is missing or unparseable — callers treat that as "the server didn't
 * emit rate-limit state" rather than a hard error.
 */
function parseRateLimit(headers: Headers): RateLimitState | null {
  const limit = headers.get("X-RateLimit-Limit");
  const remaining = headers.get("X-RateLimit-Remaining");
  const reset = headers.get("X-RateLimit-Reset");
  if (!limit || !remaining || !reset) return null;

  const limitNum = parseInt(limit, 10);
  const remainingNum = parseInt(remaining, 10);
  if (isNaN(limitNum) || isNaN(remainingNum)) return null;

  // Accept unix-seconds (number) or ISO 8601 string.
  let resetDate: Date;
  const resetNum = Number(reset);
  if (!isNaN(resetNum) && reset.trim() !== "") {
    // Unix seconds
    resetDate = new Date(resetNum * 1000);
  } else {
    resetDate = new Date(reset);
  }
  if (isNaN(resetDate.getTime())) return null;

  return { limit: limitNum, remaining: remainingNum, resetAt: resetDate };
}

function parseRetryAfter(headers: Headers): number | null {
  const v = headers.get("Retry-After");
  if (!v) return null;
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n * 1000;
}

function mapStatusToCode(status: number, errorCode?: string): AtlaSentErrorCode {
  if (status === 401 || errorCode === "invalid_api_key") return "invalid_api_key";
  if (status === 403 || errorCode === "forbidden") return "forbidden";
  if (status === 400 || errorCode === "bad_request") return "bad_request";
  if (status >= 500) return "server_error";
  return "server_error";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Streaming implementation (module-level async generator) ──────────────────
//
// Kept outside the class so it can be tested in isolation and to avoid
// `this` capture issues in the generator context.

type ChunkResult = { done: true; value?: undefined } | { done: false; value: Uint8Array };

async function* protectStreamImpl(
  baseUrl: string,
  apiKey: string,
  userAgent: string,
  fetchImpl: typeof fetch,
  request: EvaluateRequest,
  options?: StreamOptions,
): AsyncGenerator<StreamEvent> {
  const url = `${baseUrl}/v1-evaluate/stream`;
  const requestId = crypto.randomUUID();

  const body = JSON.stringify({
    action_type: request.action,
    actor_id: request.agent,
    context: request.context ?? {},
  });

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    "User-Agent": userAgent,
    "X-Request-ID": requestId,
  };

  const timeoutMs = options?.timeoutMs ?? 30_000;
  const fetchOpts: RequestInit = {
    method: "POST",
    headers,
    body,
    signal: options?.signal,
  };

  let resp: Response;
  try {
    resp = await fetchImpl(url, fetchOpts);
  } catch (err) {
    const isAbort =
      err instanceof Error &&
      (err.name === "AbortError" || err.name === "TimeoutError");
    throw new AtlaSentError(isAbort ? "Stream request aborted" : "Network error on stream", {
      code: isAbort ? "timeout" : "network",
      requestId,
    });
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    let errorBody: { error?: string; message?: string } = {};
    try {
      errorBody = JSON.parse(text);
    } catch {
      /* ignore */
    }
    throw new AtlaSentError(errorBody.message ?? `HTTP ${resp.status}`, {
      code: resp.status === 401 ? "invalid_api_key" : "server_error",
      status: resp.status,
      requestId,
    });
  }

  if (!resp.body) {
    throw new AtlaSentError("Response body is null", {
      code: "bad_response",
      requestId,
    });
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  try {
    while (true) {
      async function readChunk(): Promise<ChunkResult> {
        if (timeoutMs <= 0) {
          return reader.read();
        }
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new StreamTimeoutError(timeoutMs)),
            timeoutMs,
          ),
        );
        return Promise.race([reader.read(), timeout]);
      }

      const { done, value } = await readChunk();
      if (done) break;

      buf += decoder.decode(value, { stream: true });

      // Split on SSE double-newline boundaries.
      const events = buf.split(/\n\n/);
      buf = events.pop() ?? "";

      for (const raw of events) {
        if (!raw.trim()) continue;

        let eventType = "message";
        const dataLines: string[] = [];

        for (const line of raw.split("\n")) {
          if (line.startsWith("event:")) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trim());
          }
        }

        const data = dataLines.join("\n");
        if (!data) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch (err) {
          throw new StreamParseError(data, err);
        }

        if (eventType === "error") {
          const e = parsed as {
            code?: string;
            message?: string;
            request_id?: string;
          };
          throw new AtlaSentError(
            e.message ?? "Stream error from AtlaSent API",
            {
              code: (e.code as AtlaSentErrorCode | undefined) ?? "server_error",
              requestId: e.request_id ?? requestId,
            },
          );
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
          if (
            typeof d.permitted !== "boolean" ||
            typeof d.decision_id !== "string"
          ) {
            throw new AtlaSentError(
              "Malformed decision event from AtlaSent API",
              {
                code: "bad_response",
                requestId,
              },
            );
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
          yield {
            type: "progress",
            stage: String(p["stage"] ?? ""),
            ...p,
          } satisfies StreamProgressEvent;
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
