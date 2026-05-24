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
import type {
  ReplayDecisionResponse,
  ReplayRequest,
  ReplayResponse,
  ReplayVarianceKind,
} from "./replay.js";
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

const SDK_VERSION = "2.8.0";
const DEFAULT_BASE_URL = "https://api.atlasent.io";
const DEFAULT_TIMEOUT_MS = 10_000;

function detectRuntime(): string {
  if (
    typeof process !== "undefined" &&
    typeof process.versions?.node === "string"
  ) {
    return `node/${process.versions.node}`;
  }
  return "browser";
}

interface EvaluateWire {
  decision?: string;
  decision_canonical?: string;
  permit_token?: string;
  permit_id?: string;
  request_id?: string;
  expires_at?: string;
  audit_hash?: string;
  timestamp?: string;
  denial?: {
    code?: string;
    message?: string;
    reasons?: string[];
  };
  // Legacy fields
  permitted?: boolean;
  decision_id?: string;
  reason?: string;
  reasons?: string[];
  permitId?: string;
  evaluationId?: string;
  permit?: {
    id?: string;
    status?: string;
    actor_id?: string;
    action_type?: string;
    created_at?: string;
    expires_at?: string;
    revoked_at?: string;
    revoked_by?: string;
    revoke_reason?: string;
    payload_hash?: string;
    decision_id?: string;
    environment?: string;
    metadata?: Record<string, unknown>;
  } | null;
}

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
      throw new AtlaSentError("apiKey is required", {
        code: "invalid_api_key",
      });
    }
    if (!AbortSignal.timeout) {
      throw new AtlaSentError(
        "AbortSignal.timeout is not available in this environment. " +
          "Minimum supported browsers: Chrome 103, Firefox 100, Safari 16, Edge 103.",
        { code: "network" },
      );
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.userAgent = `@atlasent/sdk/${SDK_VERSION} ${detectRuntime()}`;
    this.retryPolicy = mergePolicy(options.retryPolicy);
  }

  // ---------------------------------------------------------------------------
  // Core evaluate / verify
  // ---------------------------------------------------------------------------

  /**
   * Evaluate an action for an agent against the active policy bundle.
   *
   * Returns {@link EvaluateResponse} with `decision: "allow" | "deny" | "hold" | "escalate"`.
   * A clean policy DENY is **not** thrown — inspect `response.decision` or `response.decision_canonical`.
   *
   * @example
   * ```ts
   * const result = await client.evaluate({
   *   agent: "deploy-bot",
   *   action: "production.deploy",
   *   context: { commit: "abc" },
   * });
   * if (result.decision_canonical !== "allow") {
   *   throw new Error(`Blocked: ${result.reason}`);
   * }
   * ```
   */
  async evaluate(
    request: EvaluateRequest | LegacyEvaluateRequest | V2EvaluateRequest,
  ): Promise<EvaluateResponse> {
    const normalized = normalizeEvaluateRequest(request);
    const { body: wire, rateLimit } = await this.post<EvaluateWire>(
      "/v1-evaluate",
      {
        action_type: normalized.action_type,
        actor_id: normalized.actor_id,
        context: normalized.context,
      },
    );

    // Map the canonical decision (preferred) or fall back to legacy fields.
    const rawDecision =
      wire.decision_canonical ??
      wire.decision ??
      (wire.permitted === true ? "allow" : "deny");
    const decision = rawDecision.toLowerCase() as DecisionCanonical;

    const permitId =
      wire.permit_id ?? wire.request_id ?? wire.decision_id ?? wire.evaluationId ?? "";
    const evaluationId = permitId;
    const permitToken = wire.permit_token ?? null;

    const reasons: string[] = Array.isArray(wire.reasons)
      ? wire.reasons
      : wire.denial?.reasons ?? (wire.reason ? [wire.reason] : []);
    const reason = reasons[0] ?? wire.denial?.message ?? wire.reason ?? "";

    // Normalise the permit record when the server returns one.
    let permit: PermitRecord | null = null;
    if (wire.permit && typeof wire.permit === "object") {
      permit = wire.permit as PermitRecord;
    }

    return {
      decision,
      decision_canonical: decision,
      evaluationId,
      permitId,
      permit,
      permitToken,
      reasons,
      reason,
      auditHash: wire.audit_hash ?? "",
      timestamp: wire.timestamp ?? new Date().toISOString(),
      rateLimit,
    };
  }

  /**
   * @deprecated Prefer {@link verifyPermitById}.
   *
   * Verify a previously-issued permit using the legacy token-in-body endpoint.
   */
  async verifyPermit(
    request: VerifyPermitRequest,
  ): Promise<VerifyPermitResponse> {
    const { body: wire, rateLimit } = await this.post<VerifyPermitWire>(
      "/v1-verify-permit",
      {
        permit_token: request.permitId,
        action_type: request.action,
        actor_id: request.agent,
        environment: request.environment,
        execution_hash: request.execution_hash,
      },
    );
    return {
      verified: wire.valid ?? wire.verified ?? false,
      outcome: wire.outcome ?? "deny",
      permitHash: wire.permit_hash ?? "",
      timestamp: wire.timestamp ?? new Date().toISOString(),
      rateLimit,
    };
  }

  async verifyPermitById(
    permitId: string,
  ): Promise<VerifyPermitByIdResponse> {
    const path = `/v1/permits/${encodeURIComponent(permitId)}/verify`;
    const { body, rateLimit } = await this.post<
      Omit<VerifyPermitByIdResponse, "rateLimit">
    >(path, {});
    return { ...body, rateLimit };
  }

  // ---------------------------------------------------------------------------
  // Permit lifecycle
  // ---------------------------------------------------------------------------

  async getPermit(permitId: string): Promise<GetPermitResponse> {
    const path = `/v1/permits/${encodeURIComponent(permitId)}`;
    const { body, rateLimit } = await this.get<{ permit: PermitRecord }>(path);
    return { permit: body.permit, rateLimit };
  }

  async listPermits(
    params: ListPermitsRequest = {},
  ): Promise<ListPermitsResponse> {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", params.status);
    if (params.actorId) qs.set("actor_id", params.actorId);
    if (params.actionType) qs.set("action_type", params.actionType);
    if (params.from) qs.set("from", params.from);
    if (params.to) qs.set("to", params.to);
    if (params.limit != null) qs.set("limit", String(params.limit));
    if (params.cursor) qs.set("cursor", params.cursor);
    const path = `/v1/permits${qs.toString() ? `?${qs}` : ""}`;
    const { body, rateLimit } = await this.get<{
      permits: PermitRecord[];
      total: number;
      next_cursor?: string;
    }>(path);
    return {
      permits: body.permits ?? [],
      total: body.total ?? 0,
      nextCursor: body.next_cursor,
      rateLimit,
    };
  }

  async checkPermitValid(permitId: string): Promise<{
    status: "active" | "revoked" | "expired" | "consumed";
    expires_at?: string;
    revoked_at?: string;
  }> {
    const path = `/v1/permits/${encodeURIComponent(permitId)}/valid`;
    const { body } = await this.get<{
      status: "active" | "revoked" | "expired" | "consumed";
      expires_at?: string;
      revoked_at?: string;
    }>(path);
    return body;
  }

  /**
   * @deprecated Use {@link revokePermitById}.
   */
  async revokePermit(
    request: RevokePermitRequest,
  ): Promise<RevokePermitResponse> {
    const { body, rateLimit } = await this.post<{
      revoked: boolean;
      permit_id?: string;
      revoked_at?: string;
      audit_hash?: string;
    }>("/v1-revoke-permit", {
      permit_token: request.permitId,
      reason: request.reason,
    });
    return {
      revoked: body.revoked ?? false,
      permitId: body.permit_id ?? request.permitId,
      revokedAt: body.revoked_at,
      auditHash: body.audit_hash,
      rateLimit,
    };
  }

  async revokePermitById(
    permitId: string,
    input: RevokePermitByIdInput = {},
  ): Promise<RevokePermitByIdResponse> {
    const path = `/v1/permits/${encodeURIComponent(permitId)}/revoke`;
    const { body, rateLimit } = await this.post<{ permit: PermitRecord }>(
      path,
      input,
    );
    return { permit: body.permit, rateLimit };
  }

  // ---------------------------------------------------------------------------
  // Evaluate batch / preflight
  // ---------------------------------------------------------------------------

  /**
   * Evaluate a batch of up to 100 items in a single round-trip.
   *
   * @example
   * ```ts
   * const { items } = await client.evaluateBatch([
   *   { agent: "bot-1", action: "file.read" },
   *   { agent: "bot-2", action: "file.write", context: { path: "/tmp" } },
   * ]);
   * ```
   */
  async evaluateBatch(
    items: BatchEvalItem[],
    options?: { batchId?: string },
  ): Promise<BatchEvalResponse> {
    interface BatchWire {
      batch_id?: string;
      items?: Array<{
        index: number;
        decision?: string;
        decision_id?: string;
        permit_token?: string | null;
        reason?: string | null;
        audit_hash?: string;
        timestamp?: string;
        error?: string;
        message?: string;
      }>;
      partial?: boolean;
      replayed?: boolean;
    }
    const body: Record<string, unknown> = {
      items: items.map((it) => ({
        actor_id: it.agent,
        action_type: it.action,
        ...(it.context ? { context: it.context } : {}),
      })),
    };
    if (options?.batchId) body.batch_id = options.batchId;
    const { body: wire, rateLimit } =
      await this.post<BatchWire>("/v1-evaluate-batch", body);
    const resultItems: EvaluateBatchResultItem[] = (wire.items ?? []).map(
      (it) => ({
        index: it.index,
        decision: it.decision?.toLowerCase() as DecisionCanonical | undefined,
        decisionId: it.decision_id,
        permitToken: it.permit_token,
        reason: it.reason,
        auditHash: it.audit_hash,
        timestamp: it.timestamp,
        error: it.error,
        message: it.message,
      }),
    );
    return {
      batchId: wire.batch_id ?? "",
      items: resultItems,
      partial: wire.partial ?? false,
      ...(wire.replayed ? { replayed: wire.replayed } : {}),
      rateLimit,
    };
  }

  /**
   * the last received `event.id` to resume without replaying history.
   *
   * Evaluate an action and return both the decision and the per-stage
   * policy constraint trace.
   *
   * @example
   * ```ts
   * const { evaluation, constraintTrace } = await client.evaluatePreflight({
   *   agent: "deploy-bot",
   *   action: "production.deploy",
   * });
   * console.log(constraintTrace?.stages);
   * ```
   */
  async evaluatePreflight(
    request: EvaluateRequest,
  ): Promise<EvaluatePreflightResponse> {
    interface PreflightWire extends EvaluateWire {
      constraint_trace?: ConstraintTrace | null;
    }
    const normalized = normalizeEvaluateRequest(request);
    const { body: wire, rateLimit } = await this.post<PreflightWire>(
      "/v1-evaluate?include=constraint_trace",
      {
        action_type: normalized.action_type,
        actor_id: normalized.actor_id,
        context: normalized.context,
      },
    );

    const rawDecision =
      wire.decision_canonical ??
      wire.decision ??
      (wire.permitted === true ? "allow" : "deny");
    const decision = rawDecision.toLowerCase() as DecisionCanonical;
    const permitId =
      wire.permit_id ?? wire.request_id ?? wire.decision_id ?? wire.evaluationId ?? "";
    const permitToken = wire.permit_token ?? null;
    const reasons: string[] = Array.isArray(wire.reasons)
      ? wire.reasons
      : wire.denial?.reasons ?? (wire.reason ? [wire.reason] : []);
    const reason = reasons[0] ?? wire.denial?.message ?? wire.reason ?? "";
    let permit: PermitRecord | null = null;
    if (wire.permit && typeof wire.permit === "object") {
      permit = wire.permit as PermitRecord;
    }
    const evaluation: EvaluateResponse = {
      decision,
      decision_canonical: decision,
      evaluationId: permitId,
      permitId,
      permit,
      permitToken,
      reasons,
      reason,
      auditHash: wire.audit_hash ?? "",
      timestamp: wire.timestamp ?? new Date().toISOString(),
      rateLimit,
    };
    return {
      evaluation,
      constraintTrace: wire.constraint_trace ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // Key self-describe
  // ---------------------------------------------------------------------------

  async keySelf(): Promise<ApiKeySelfResponse> {
    interface KeySelfWire {
      key_id?: string;
      organization_id?: string;
      environment?: string;
      scopes?: string[];
      allowed_cidrs?: string[] | null;
      rate_limit_per_minute?: number;
      client_ip?: string | null;
      expires_at?: string | null;
    }
    const { body: wire, rateLimit } =
      await this.get<KeySelfWire>("/v1-api-key-self");
    return {
      keyId: wire.key_id ?? "",
      organizationId: wire.organization_id ?? "",
      environment: wire.environment ?? "",
      scopes: wire.scopes ?? [],
      allowedCidrs: wire.allowed_cidrs ?? null,
      rateLimitPerMinute: wire.rate_limit_per_minute ?? 0,
      clientIp: wire.client_ip ?? null,
      expiresAt: wire.expires_at ?? null,
      rateLimit,
    };
  }

  // ---------------------------------------------------------------------------
  // Audit events
  // ---------------------------------------------------------------------------

  async listAuditEvents(
    query: import("./types.js").AuditEventsQuery = {},
  ): Promise<AuditEventsResult> {
    const qs = new URLSearchParams();
    if (query.types) qs.set("types", query.types);
    if (query.actorId) qs.set("actor_id", query.actorId);
    if (query.from) qs.set("from", query.from);
    if (query.to) qs.set("to", query.to);
    if (query.limit != null) qs.set("limit", String(query.limit));
    if (query.cursor) qs.set("cursor", query.cursor);
    const path = `/v1-audit/events${qs.toString() ? `?${qs}` : ""}`;
    const { body, rateLimit } = await this.get<AuditEventsPage>(path);
    return { ...body, rateLimit };
  }

  async createAuditExport(
    request: AuditExportRequest = {},
  ): Promise<AuditExportResult> {
    const { body, rateLimit } = await this.post<AuditExport>(
      "/v1-audit/exports",
      request,
    );
    return { ...body, rateLimit };
  }

  // ---------------------------------------------------------------------------
  // Deploy Gate
  // ---------------------------------------------------------------------------

  /**
   * Run the full `production.deploy` guard in one call:
   * evaluate → verify permit → return evidence.
   *
   * @example
   * ```ts
   * const gate = await client.deployGate({ agent: "ci-bot", context: { sha: "abc" } });
   * if (!gate.allowed) throw new Error(gate.reason);
   * ```
   */
  async deployGate(
    request: DeployGateRequest = {},
  ): Promise<DeployGateResponse> {
    const agent = request.agent ?? "ci-deploy-bot";
    const action = request.action ?? PRODUCTION_DEPLOY_ACTION;
    const context = request.context ?? {};

    const evaluation = await this.evaluate({ agent, action, context });
    if (evaluation.decision !== "allow") {
      return {
        allowed: false,
        evaluation,
        reason: evaluation.reason || "Policy denied the deploy action.",
        evidence: {},
      };
    }

    const verification = await this.verifyPermit({
      permitId: evaluation.permitId,
      agent,
      action,
    });

    const evidence: DeployGateEvidence = {
      permitId: evaluation.permitId,
      auditHash: evaluation.auditHash,
      verifiedAt: new Date().toISOString(),
    };
    if (verification.permitHash) evidence.permitHash = verification.permitHash;

    return {
      allowed: verification.verified,
      evaluation,
      verification,
      reason: verification.verified
        ? "Deploy authorized and permit verified."
        : "Permit verification failed.",
      evidence,
    };
  }

  // ---------------------------------------------------------------------------
  // Streaming
  // ---------------------------------------------------------------------------

  /**
   * Open a streaming evaluation session against `POST /v1-evaluate-stream`.
   *
   * Yields {@link StreamDecisionEvent} and {@link StreamProgressEvent} objects
   * as the server emits them. The iterator ends cleanly when the server sends
   * `event: done`; it throws {@link AtlaSentError} on transport errors or when
   * the server sends `event: error`.
   */
  async *protectStream(
    request: EvaluateRequest,
    opts: StreamOptions = {},
  ): AsyncGenerator<StreamEvent> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const maxRetries = opts.maxRetries ?? 3;
    const externalSignal = opts.signal;

    const normalized = normalizeEvaluateRequest(request);
    const body = {
      action_type: normalized.action_type,
      actor_id: normalized.actor_id,
      context: normalized.context,
    };

    let lastEventId: string | undefined;
    let attempts = 0;

    while (true) {
      attempts++;
      const ac = new AbortController();
      if (externalSignal?.aborted) ac.abort(externalSignal.reason);
      externalSignal?.addEventListener("abort", () =>
        ac.abort(externalSignal.reason),
      );

      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs > 0) {
        timeoutHandle = setTimeout(() => ac.abort("stream_timeout"), timeoutMs);
      }

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "text/event-stream",
        "User-Agent": this.userAgent,
        "X-Request-ID": crypto.randomUUID(),
      };
      if (lastEventId != null) headers["Last-Event-ID"] = lastEventId;

      let response: Response;
      try {
        response = await this.fetchImpl(
          `${this.baseUrl}/v1-evaluate-stream`,
          {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: ac.signal,
          },
        );
      } catch (err) {
        clearTimeout(timeoutHandle);
        if (
          err instanceof Error &&
          err.message === "stream_timeout"
        ) {
          throw new StreamTimeoutError(timeoutMs);
        }
        if (attempts <= maxRetries) continue;
        throw new AtlaSentError(
          `Network error: ${err instanceof Error ? err.message : String(err)}`,
          { code: "network" },
        );
      } finally {
        clearTimeout(timeoutHandle);
      }

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new AtlaSentError(
          `Stream request failed: ${response.status} ${response.statusText}`,
          { code: "server_error", status: response.status, body: errText },
        );
      }

      yield* readSSEStream(response, timeoutMs, (id) => {
        lastEventId = id;
      });
      return;
    }
  }

  /**
   * Subscribe to the live decision stream (`GET /v1-decisions-stream`).
   *
   * Yields {@link DecisionStreamEvent} objects as the server emits them.
   * Reconnects automatically when `opts.lastEventId` is supplied.
   */
  async *subscribeDecisions(
    opts: SubscribeDecisionsOptions = {},
  ): AsyncGenerator<DecisionStreamEvent> {
    const qs = new URLSearchParams();
    if (opts.types?.length) qs.set("types", opts.types.join(","));
    if (opts.actorId) qs.set("actor_id", opts.actorId);
    if (opts.maxSeconds != null)
      qs.set("max_seconds", String(opts.maxSeconds));
    const path = `/v1-decisions-stream${qs.toString() ? `?${qs}` : ""}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "text/event-stream",
      "User-Agent": this.userAgent,
      "X-Request-ID": crypto.randomUUID(),
    };
    if (opts.lastEventId) headers["Last-Event-ID"] = opts.lastEventId;

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers,
      signal: opts.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new AtlaSentError(
        `Decision stream request failed: ${response.status}`,
        { code: "server_error", status: response.status, body: errText },
      );
    }

    yield* readSSEStream(
      response,
      0,
      () => {},
      (event) => event as unknown as DecisionStreamEvent,
    );
  }

  // ---------------------------------------------------------------------------
  // Audit bundle
  // ---------------------------------------------------------------------------

  async createAuditBundle(): Promise<AuditExport> {
    const { body } = await this.post<AuditExport>("/v1-audit/exports", {});
    return body;
  }

  // ---------------------------------------------------------------------------
  // Governance graph
  // ---------------------------------------------------------------------------

  async listGovernanceAgents(): Promise<ListGovernanceAgentsResponse> {
    const { body } =
      await this.get<ListGovernanceAgentsResponse>("/v1/governance/agents");
    return body;
  }

  async listGovernanceFindings(
    params: ListGovernanceFindingsQuery = {},
  ): Promise<ListGovernanceFindingsResponse> {
    const qs = new URLSearchParams();
    if (params.change_id) qs.set("change_id", params.change_id);
    if (params.agent_slug) qs.set("agent_slug", params.agent_slug);
    if (params.severity) qs.set("severity", params.severity);
    const path = `/v1/governance/findings${qs.toString() ? `?${qs}` : ""}`;
    const { body } = await this.get<ListGovernanceFindingsResponse>(path);
    return body;
  }

  async listGovernanceEvaluations(
    params: ListGovernanceEvaluationsQuery = {},
  ): Promise<ListGovernanceEvaluationsResponse> {
    const qs = new URLSearchParams();
    if (params.change_id) qs.set("change_id", params.change_id);
    if (params.agent_slug) qs.set("agent_slug", params.agent_slug);
    const path = `/v1/governance/evaluations${qs.toString() ? `?${qs}` : ""}`;
    const { body } =
      await this.get<ListGovernanceEvaluationsResponse>(path);
    return [...(body.evaluations ?? [])];
  }

  /**
   * Re-evaluate a recorded decision against its originally-pinned policy
   * bundle and engine version, and report whether the result agrees with
   * what was recorded.
   *
   * Wraps `POST /v1-decisions-replay/:id/replay`. **Side-effect-free** — no
   * audit chain row is written and no permit is issued (per ADR-016).
   * Useful for compliance review, regression testing of bundle changes,
   * and post-incident investigation.
   *
   * Outcomes encoded in the response:
   * - `variance: "NONE"` — replay agrees with the original decision.
   * - `variance: "DECISION_CHANGED"` — same envelope, same bundle, different
   *   decision. Almost always indicates non-determinism in a rule
   *   (e.g. wall-clock comparison) and warrants investigation.
   * - `variance: "ENVELOPE_DRIFT"` — the recorded request envelope no longer
   *   hashes to the recorded value. The replay short-circuits without
   *   running the engine; `replay_decision` is absent. Treat as evidence
   *   of substrate tamper or a recorder bug.
   *
   * Server-side 409 responses (replay refused because the engine version
   * does not accept replay, or because no bundle was pinned) surface as
   * `AtlaSentError` with `code: "replay_not_eligible"` — callers should
   * treat them as expected for old / un-pinned decisions, not as bugs.
   *
   * Requires the `evaluate:write` API key scope.
   *
   * @param decisionId The UUID of the recorded decision to replay.
   *                   Matches `execution_evaluations.request_id`.
   *
   * @example
   * ```ts
   * const result = await client.replayDecision("dec_abc123");
   * if (result.variance === "DECISION_CHANGED") {
   *   console.warn(
   *     `Decision ${result.decision_id} changed on replay: ` +
   *     `${result.original_decision} → ${result.replay_decision}`,
   *   );
   * }
   * ```
   */
  async replayDecision(
    decisionId: string,
  ): Promise<ReplayDecisionResponse & { rateLimit: RateLimitState | null }> {
    if (typeof decisionId !== "string" || decisionId.length === 0) {
      throw new AtlaSentError("decisionId is required", {
        code: "bad_request",
      });
    }

    const path = `/v1-decisions-replay/${encodeURIComponent(decisionId)}/replay`;
    const { body: wire, rateLimit } = await this.post<ReplayDecisionResponse>(
      path,
      {},
    );

    // Defensive validation. The replay endpoint is alpha (see
    // STABLE_V2_PROMOTION.md) — wire shapes can shift without a
    // deprecation cycle, so guard the contract fields callers will
    // branch on rather than trusting the cast.
    if (
      typeof wire.decision_id !== "string" ||
      typeof wire.original_decision !== "string" ||
      typeof wire.engine_version_kind !== "string" ||
      typeof wire.accepts_replay !== "boolean" ||
      typeof wire.variance !== "string" ||
      typeof wire.envelope_verification !== "string" ||
      typeof wire.replayed_at !== "string"
    ) {
      throw new AtlaSentError(
        "Malformed response from /v1-decisions-replay/:id/replay: missing required fields",
        { code: "bad_response" },
      );
    }

    return { ...wire, rateLimit };
  }

  async replay(request: ReplayRequest): Promise<ReplayResponse> {
    const path = `/v1/decisions/${encodeURIComponent(request.evaluationId)}/replay`;
    let wireBody: ReplayWire;
    let rateLimit: RateLimitState | null;
    try {
      const result = await this.post<ReplayWire>(path, {});
      wireBody = result.body;
      rateLimit = result.rateLimit;
    } catch (err) {
      // 409 replay_not_eligible → ENGINE_DRIFT or BUNDLE_MISSING; never throws.
      if (err instanceof AtlaSentError && err.status === 409) {
        const msg = err.message ?? "";
        const varianceKind: ReplayVarianceKind = msg.toLowerCase().includes("bundle")
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

  // ---------------------------------------------------------------------------
  // HTTP primitives
  // ---------------------------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ body: T; rateLimit: RateLimitState | null }> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      "User-Agent": this.userAgent,
      "X-Request-ID": crypto.randomUUID(),
    };

    let lastErr: unknown;
    for (let attempt = 1; hasAttemptsLeft(this.retryPolicy, attempt); attempt++) {
      if (attempt > 1) {
        const delayMs = computeBackoffMs(this.retryPolicy, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        lastErr = err;
        if (
          err instanceof Error &&
          (err.name === "TimeoutError" || err.name === "AbortError")
        ) {
          const sdkErr = new AtlaSentError(
            `Request timed out after ${this.timeoutMs}ms`,
            { code: "timeout" },
          );
          if (!isRetryable(sdkErr, this.retryPolicy)) throw sdkErr;
          lastErr = sdkErr;
          continue;
        }
        const sdkErr = new AtlaSentError(
          `Network error: ${err instanceof Error ? err.message : String(err)}`,
          { code: "network" },
        );
        if (!isRetryable(sdkErr, this.retryPolicy)) throw sdkErr;
        lastErr = sdkErr;
        continue;
      }

      const rateLimit = parseRateLimitHeaders(response.headers);

      if (response.status === 429) {
        const retryAfterHeader = response.headers.get("Retry-After");
        const retryAfterMs = retryAfterHeader
          ? parseFloat(retryAfterHeader) * 1000
          : undefined;
        const err = new AtlaSentError(`Rate limited`, {
          code: "rate_limited",
          status: 429,
          retryAfterMs,
        });
        if (!isRetryable(err, this.retryPolicy)) throw err;
        lastErr = err;
        continue;
      }

      if (!response.ok) {
        let responseBody: Record<string, unknown> | undefined;
        let bodyText: string | undefined;
        try {
          bodyText = await response.text();
          responseBody = bodyText ? JSON.parse(bodyText) : undefined;
        } catch {
          // ignore parse errors
        }

        const message =
          (responseBody?.message as string | undefined) ??
          (responseBody?.error as string | undefined) ??
          `HTTP ${response.status} ${response.statusText}`;

        let code: AtlaSentErrorCode;
        if (response.status === 401) code = "invalid_api_key";
        else if (response.status === 403) code = "forbidden";
        else if (response.status === 404) code = "not_found";
        else if (response.status === 409) code = "conflict";
        else if (response.status === 400) code = "bad_request";
        else if (response.status >= 500) code = "server_error";
        else code = "bad_response";

        const requestId =
          response.headers.get("X-Request-ID") ??
          response.headers.get("x-request-id") ??
          undefined;

        const err = new AtlaSentError(message, {
          code,
          status: response.status,
          requestId,
          body: responseBody ?? bodyText,
        });
        if (!isRetryable(err, this.retryPolicy)) throw err;
        lastErr = err;
        continue;
      }

      let parsed: T;
      try {
        parsed = (await response.json()) as T;
      } catch {
        const err = new AtlaSentError(
          "Failed to parse JSON response from server",
          { code: "bad_response", status: response.status },
        );
        if (!isRetryable(err, this.retryPolicy)) throw err;
        lastErr = err;
        continue;
      }

      return { body: parsed, rateLimit };
    }

    throw lastErr;
  }

  private post<T>(
    path: string,
    body: unknown,
  ): Promise<{ body: T; rateLimit: RateLimitState | null }> {
    return this.request<T>("POST", path, body);
  }

  private get<T>(
    path: string,
  ): Promise<{ body: T; rateLimit: RateLimitState | null }> {
    return this.request<T>("GET", path);
  }
}

// ---------------------------------------------------------------------------
// Rate-limit header parser
// ---------------------------------------------------------------------------

/**
 * Parse the server's `X-RateLimit-*` header triple into a typed
 * {@link RateLimitState}. Returns `null` when any of the three headers
 * is missing or unparseable — callers treat that as "the server didn't
 * emit rate-limit state" rather than "the window is empty".
 *
 * `X-RateLimit-Reset` is accepted as either unix-seconds (what the
 * AtlaSent edge functions emit today) or an ISO 8601 timestamp.
 */
function parseRateLimitHeaders(
  headers: Headers,
): RateLimitState | null {
  const limitRaw = headers.get("X-RateLimit-Limit");
  const remainingRaw = headers.get("X-RateLimit-Remaining");
  const resetRaw = headers.get("X-RateLimit-Reset");
  if (!limitRaw || !remainingRaw || !resetRaw) return null;

  const limit = parseInt(limitRaw, 10);
  const remaining = parseInt(remainingRaw, 10);
  if (!Number.isFinite(limit) || !Number.isFinite(remaining)) return null;

  // Accept unix-seconds or ISO 8601.
  let resetAt: string;
  const asUnix = parseFloat(resetRaw);
  if (Number.isFinite(asUnix) && asUnix > 1_000_000_000) {
    resetAt = new Date(asUnix * 1000).toISOString();
  } else {
    const d = new Date(resetRaw);
    if (isNaN(d.getTime())) return null;
    resetAt = d.toISOString();
  }

  return { limit, remaining, resetAt };
}

// ---------------------------------------------------------------------------
// SSE stream reader
// ---------------------------------------------------------------------------

async function* readSSEStream(
  response: Response,
  timeoutMs: number,
  onEventId: (id: string) => void,
  transformEvent?: (event: Record<string, unknown>) => StreamEvent,
): AsyncGenerator<StreamEvent> {
  const reader = response.body?.getReader();
  if (!reader) throw new AtlaSentError("No response body", { code: "bad_response" });

  const decoder = new TextDecoder();
  let buf = "";
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  function resetTimeout() {
    clearTimeout(timeoutHandle);
    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        reader.cancel("stream_timeout").catch(() => {});
      }, timeoutMs);
    }
  }

  try {
    resetTimeout();
    while (true) {
      let value: Uint8Array | undefined;
      let done: boolean;
      try {
        ({ value, done } = await reader.read());
      } catch (err) {
        if (
          err instanceof Error &&
          (err.message === "stream_timeout" || err.name === "AbortError")
        ) {
          throw new StreamTimeoutError(timeoutMs);
        }
        throw err;
      }
      resetTimeout();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // Process complete SSE messages (double-newline terminated).
      let boundary: number;
      while ((boundary = buf.indexOf("\n\n")) !== -1) {
        const message = buf.slice(0, boundary);
        buf = buf.slice(boundary + 2);

        let eventType = "";
        let eventData = "";
        let eventId = "";

        for (const line of message.split("\n")) {
          if (line.startsWith("event:")) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            eventData = line.slice(5).trim();
          } else if (line.startsWith("id:")) {
            eventId = line.slice(3).trim();
          }
        }

        if (eventId) onEventId(eventId);

        if (eventType === "done" || eventType === "close") {
          clearTimeout(timeoutHandle);
          return;
        }
        if (eventType === "error") {
          let errMsg = "Stream error from server";
          try {
            const parsed = JSON.parse(eventData);
            if (typeof parsed.message === "string") errMsg = parsed.message;
          } catch {
            // ignore
          }
          throw new AtlaSentError(errMsg, { code: "server_error" });
        }

        if (!eventData) continue;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(eventData);
        } catch {
          throw new StreamParseError(eventData);
        }

        if (transformEvent) {
          yield transformEvent(parsed);
          continue;
        }

        if (eventType === "decision" || parsed.type === "decision") {
          yield {
            type: "decision",
            id: eventId || undefined,
            decision: ((parsed.decision as string) ?? "deny").toLowerCase() as DecisionCanonical,
            isFinal: (parsed.is_final as boolean) ?? true,
            permitId: (parsed.permit_id as string) ?? undefined,
            reason: (parsed.reason as string) ?? undefined,
          } satisfies StreamDecisionEvent;
          if ((parsed as Record<string, unknown>).is_final === true) return;
        } else if (eventType === "progress" || parsed.type === "progress") {
          const p = parsed as Record<string, unknown>;
          yield {
            type: "progress",
            id: eventId || undefined,
            message: String(p["message"] ?? ""),
            percent:
              typeof p["percent"] === "number" ? p["percent"] : undefined,
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
