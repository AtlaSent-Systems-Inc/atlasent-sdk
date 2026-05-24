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
  ReplayRequest,
  ReplayResponse,
  ReplayVarianceKind,
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

function _warnOversizeContext(
  context: Record<string, unknown> | undefined,
): void {
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

interface EvaluateBatchWireItem {
  index: number;
  decision?: string;
  decision_id?: string;
  permit_token?: string | null;
  reason?: string | null;
  audit_entry_hash?: string;
  timestamp?: string;
  error?: string;
  message?: string;
  status?: number;
}

interface EvaluateBatchWire {
  batch_id: string;
  items: EvaluateBatchWireItem[];
  partial?: boolean;
  replayed?: boolean;
}

function deployGateEvidence(input: {
  permitId?: string;
  permitHash?: string;
  auditHash?: string;
  verifiedAt?: string;
}): DeployGateEvidence {
  const evidence: DeployGateEvidence = {};
  if (input.permitId) evidence.permitId = input.permitId;
  if (input.permitHash) evidence.permitHash = input.permitHash;
  if (input.auditHash) evidence.auditHash = input.auditHash;
  if (input.verifiedAt) evidence.verifiedAt = input.verifiedAt;
  return evidence;
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
    const { body: wire, rateLimit } = await this.post<EvaluateWire>(
      "/v1-evaluate",
      body,
    );

    // Normalise decision to lowercase canonical form. API responses may
    // arrive as uppercase (legacy deployments) or lowercase (canonical);
    // we always emit lowercase so callers can rely on a stable vocabulary.
    let decision = (
      typeof wire.decision === "string"
        ? wire.decision.toLowerCase()
        : wire.decision
    ) as EvaluateWire["decision"] | undefined;

    // Tolerate both canonical {decision, permit_token} and legacy
    // {permitted, decision_id} server responses.
    if (decision === undefined && typeof wire.permitted === "boolean") {
      decision = wire.permitted ? "allow" : "deny";
    }
    const permitToken = wire.permit_token ?? wire.decision_id;

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
    if (
      decision === "allow" &&
      (typeof permitToken !== "string" || permitToken.length === 0)
    ) {
      throw new AtlaSentError(
        "Malformed response from /v1-evaluate: decision='allow' but no `permit_token` (or legacy `decision_id`)",
        { code: "bad_response" },
      );
    }

    const reason = wire.denial?.reason ?? wire.reason ?? "";
    const permitId = permitToken ?? "";
    return {
      decision,
      decision_canonical: decision,
      evaluationId: permitId,
      permitId,
      // /v1-evaluate does not return a control-plane-shaped Permit body;
      // callers needing the full record fetch GET /v1/permits/:id.
      permit: null,
      permitToken: decision === "allow" ? (permitToken ?? null) : null,
      reasons: reason ? [reason] : [],
      reason,
      auditHash: wire.audit_hash ?? "",
      timestamp: wire.timestamp ?? "",
      rateLimit,
    };
  }

  /**
   * Batch evaluate — send up to 100 decisions in a single round-trip.
   *
   * Wraps `POST /v1-evaluate-batch`. The server evaluates each item
   * against the active policy bundle and returns results in the same
   * order as the input. One rate-limit token is consumed for the
   * whole batch, and one audit-chain entry lists every included
   * decision id.
   *
   * A per-item policy `deny` is **not** thrown — it appears as
   * `item.decision === "deny"` in the returned items. A whole-batch
   * network error, 4xx, or 5xx throws {@link AtlaSentError}.
   *
   * Requires the `v2_batch` tenant feature flag to be enabled on the
   * org (returns 404 when off). Requires scope `evaluate:write`.
   *
   * @param requests - 1–100 evaluate items.
   * @param batchId  - Optional caller-supplied UUID for idempotency.
   *   A retried call with the same `batchId` and identical items
   *   returns the cached response within 24 h (`replayed: true`).
   */
  async evaluateBatch(
    requests: BatchEvalItem[],
    batchId?: string,
  ): Promise<BatchEvalResponse> {
    if (!Array.isArray(requests) || requests.length === 0) {
      throw new AtlaSentError(
        "evaluateBatch: requests must be a non-empty array",
        { code: "bad_request" },
      );
    }
    if (requests.length > 100) {
      throw new AtlaSentError(
        `evaluateBatch: requests.length ${requests.length} exceeds the 100-item cap`,
        { code: "bad_request" },
      );
    }

    const wireItems = requests.map((r) => ({
      action_type: r.action,
      actor_id: r.agent,
      context: r.context ?? {},
    }));

    const wireBody: Record<string, unknown> = { items: wireItems };
    if (batchId) wireBody.batch_id = batchId;

    const { body: wire, rateLimit } = await this.post<EvaluateBatchWire>(
      "/v1-evaluate-batch",
      wireBody,
    );

    const items: EvaluateBatchResultItem[] = (wire.items ?? []).map(
      (item: EvaluateBatchWireItem) => {
        const rawDecision = typeof item.decision === "string"
          ? item.decision.toLowerCase()
          : undefined;
        const decision = (
          rawDecision === "allow" ||
          rawDecision === "deny" ||
          rawDecision === "hold" ||
          rawDecision === "escalate"
            ? rawDecision
            : undefined
        ) as DecisionCanonical | undefined;

        return {
          index: item.index,
          ...(decision !== undefined ? { decision } : {}),
          ...(item.decision_id ? { decisionId: item.decision_id } : {}),
          ...(item.permit_token != null ? { permitToken: item.permit_token } : {}),
          ...(item.reason != null ? { reason: item.reason } : {}),
          ...(item.audit_entry_hash ? { auditHash: item.audit_entry_hash } : {}),
          ...(item.timestamp ? { timestamp: item.timestamp } : {}),
          ...(item.error ? { error: item.error } : {}),
          ...(item.message ? { message: item.message } : {}),
        } satisfies EvaluateBatchResultItem;
      },
    );

    return {
      batchId: wire.batch_id,
      items,
      partial: wire.partial ?? false,
      ...(wire.replayed ? { replayed: wire.replayed } : {}),
      rateLimit,
    };
  }

  /**
   * Subscribe to a live stream of decisions for this org.
   *
   * Wraps `GET /v1-decisions-stream`. The server emits one SSE frame
   * per audit event and sends a heartbeat every 15 s. The session
   * auto-closes after `maxSeconds` (default 30 min); reconnect with
   * the last received `event.id` to resume without replaying history.
   *
   * ```ts
   * const controller = new AbortController();
   * for await (const event of client.subscribeDecisions({ signal: controller.signal })) {
   *   if (event.type === "heartbeat") continue;
   *   console.log(event.type, event.decision, event.actorId);
   *   if (event.type === "session_end") break; // reconnect
   * }
   * ```
   *
   * Requires scope `audit:read`. Requires the `v2_decisions_stream`
   * tenant feature flag (returns 404 when off).
   */
  async *subscribeDecisions(
    opts: SubscribeDecisionsOptions = {},
  ): AsyncGenerator<DecisionStreamEvent> {
    const url = new URL(`${this.baseUrl}/v1-decisions-stream`);
    if (opts.types?.length) url.searchParams.set("types", opts.types.join(","));
    if (opts.actorId) url.searchParams.set("actor_id", opts.actorId);
    if (opts.maxSeconds !== undefined) url.searchParams.set("max_seconds", String(opts.maxSeconds));

    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      Authorization: `Bearer ${this.apiKey}`,
      "User-Agent": this.userAgent,
    };
    if (opts.lastEventId) headers["Last-Event-ID"] = opts.lastEventId;

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: "GET",
        headers,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      throw new AtlaSentError(
        `Failed to connect to decisions stream: ${err instanceof Error ? err.message : String(err)}`,
        { code: "network" },
      );
    }

    if (!response.ok) {
      const code = response.status === 401 ? "invalid_api_key" : "server_error";
      throw new AtlaSentError(
        `Decisions stream returned ${response.status}`,
        { code, status: response.status },
      );
    }

    if (!response.body) {
      throw new AtlaSentError("Decisions stream response has no body", { code: "bad_response" });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";

    try {
      while (true) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") return;
          throw new AtlaSentError(
            `Decisions stream read error: ${err instanceof Error ? err.message : String(err)}`,
            { code: "network" },
          );
        }
        if (chunk.done) break;

        buf += decoder.decode(chunk.value, { stream: true });
        const rawBlocks = buf.split("\n\n");
        buf = rawBlocks.pop() ?? "";

        for (const block of rawBlocks) {
          if (!block.trim()) continue;

          // SSE comment / heartbeat line (": …")
          if (block.trimStart().startsWith(":")) {
            yield { type: "heartbeat" };
            continue;
          }

          let id: string | undefined;
          let eventType = "audit_event";
          let dataLine = "";

          for (const line of block.split("\n")) {
            if (line.startsWith("id:")) id = line.slice(3).trim();
            else if (line.startsWith("event:")) eventType = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLine = line.slice(5).trim();
          }

          if (!dataLine) continue;

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(dataLine) as Record<string, unknown>;
          } catch {
            continue;
          }

          if (eventType === "session_end") {
            yield { ...(id !== undefined ? { id } : {}), type: "session_end", payload: parsed };
            return;
          }

          const decision = typeof parsed.decision === "string"
            ? parsed.decision.toLowerCase() as DecisionCanonical
            : undefined;

          yield {
            ...(id !== undefined ? { id } : {}),
            type: eventType,
            ...(decision ? { decision } : {}),
            ...(typeof parsed.actor_id === "string" ? { actorId: parsed.actor_id } : {}),
            ...(typeof parsed.resource_type === "string" ? { resourceType: parsed.resource_type } : {}),
            ...(typeof parsed.resource_id === "string" ? { resourceId: parsed.resource_id } : {}),
            ...(parsed.payload && typeof parsed.payload === "object" ? { payload: parsed.payload as Record<string, unknown> } : {}),
            ...(typeof parsed.hash === "string" ? { hash: parsed.hash } : {}),
            ...(typeof parsed.previous_hash === "string" ? { previousHash: parsed.previous_hash } : {}),
            ...(typeof parsed.occurred_at === "string" ? { occurredAt: parsed.occurred_at } : {}),
          } satisfies DecisionStreamEvent;
        }
      }
    } finally {
      reader.releaseLock();
    }
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
    let decision = (
      typeof wire.decision === "string"
        ? wire.decision.toLowerCase()
        : wire.decision
    ) as EvaluateWire["decision"] | undefined;

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

    const reason = wire.denial?.reason ?? wire.reason ?? "";
    const permitId = permitToken ?? "";
    const evaluation: EvaluateResponse = {
      decision,
      decision_canonical: decision,
      evaluationId: permitId,
      permitId,
      // /v1-evaluate does not return a control-plane-shaped Permit body;
      // callers needing the full record fetch GET /v1/permits/:id.
      permit: null,
      permitToken: decision === "allow" ? (permitToken ?? null) : null,
      reasons: reason ? [reason] : [],
      reason,
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
    const body: Record<string, unknown> = {
      permit_token: input.permitId,
      action_type: input.action ?? "",
      actor_id: input.agent ?? "",
    };
    if (input.environment !== undefined) {
      body.environment = input.environment;
    }
    if (input.execution_hash !== undefined) {
      body.execution_hash = input.execution_hash;
    }
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
   * Run the canonical Deploy Gate V1 flow:
   * evaluate `production.deploy`, verify the issued permit server-side,
   * and return allow/block plus audit/evidence metadata.
   *
   * This helper never treats a signed/offline permit artifact as sufficient
   * authorization. Execution is allowed only when `POST /v1-evaluate` returns
   * `decision: "allow"` with a permit AND `POST /v1-verify-permit` returns
   * `verified: true` / `valid: true`.
   */
  async deployGate(input: DeployGateRequest = {}): Promise<DeployGateResponse> {
    const agent = input.agent ?? "ci-deploy-bot";
    const action = input.action ?? PRODUCTION_DEPLOY_ACTION;
    const context = input.context ?? {};

    const evaluation = await this.evaluate({ agent, action, context });
    if (evaluation.decision !== "allow") {
      return {
        allowed: false,
        evaluation,
        reason:
          evaluation.reason ||
          `Deploy Gate blocked by decision=${evaluation.decision}`,
        evidence: deployGateEvidence({
          permitId: evaluation.permitId,
          auditHash: evaluation.auditHash,
        }),
      };
    }

    const verification = await this.verifyPermit({
      permitId: evaluation.permitId,
      agent,
      action,
      context,
    });

    if (!verification.verified) {
      return {
        allowed: false,
        evaluation,
        verification,
        reason: verification.outcome
          ? `Deploy Gate blocked by permit verification outcome=${verification.outcome}`
          : "Deploy Gate blocked because permit verification failed",
        evidence: deployGateEvidence({
          permitId: evaluation.permitId,
          permitHash: verification.permitHash,
          auditHash: evaluation.auditHash,
          verifiedAt: verification.timestamp,
        }),
      };
    }

    return {
      allowed: true,
      evaluation,
      verification,
      reason: evaluation.reason || "Deploy Gate permit verified",
      evidence: deployGateEvidence({
        permitId: evaluation.permitId,
        permitHash: verification.permitHash,
        auditHash: evaluation.auditHash,
        verifiedAt: verification.timestamp,
      }),
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
  async revokePermit(
    input: RevokePermitRequest,
  ): Promise<RevokePermitResponse> {
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

    if (
      typeof wire.revoked !== "boolean" ||
      typeof wire.decision_id !== "string"
    ) {
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
   * Poll whether a permit is currently valid.
   *
   * Calls `GET /v1/permits/{permitId}/valid` — a lightweight read
   * returning only the status snapshot optimised for guard heartbeat
   * polling. Guards with `permitRevalidationIntervalMs` set race this
   * against `tool.execute()` and throw {@link PermitRevoked} when
   * `status === "revoked"` arrives.
   *
   * Throws {@link AtlaSentError} on transport / auth failures.
   */
  async checkPermitValid(permitId: string): Promise<PermitValidResponse> {
    if (!permitId) {
      throw new AtlaSentError("permitId is required", { code: "bad_request" });
    }
    const { body } = await this.get<PermitValidResponse>(
      `/v1/permits/${encodeURIComponent(permitId)}/valid`,
    );
    return body;
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
    const { body: wire, rateLimit } =
      await this.get<ApiKeySelfWire>("/v1-api-key-self");

    if (
      typeof wire.key_id !== "string" ||
      typeof wire.organization_id !== "string"
    ) {
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
        "Malformed response from /v1-audit/exports: missing `export_id`, `chain_head_hash`, or `events`",
        { code: "bad_response" },
      );
    }

    return { ...wire, rateLimit };
  }

  /**
   * Open a streaming evaluation session against `POST /v1-evaluate-stream`.
   *
   * Yields {@link StreamDecisionEvent} and {@link StreamProgressEvent} objects
   * as the server emits them. The iterator ends cleanly when the server sends
   * `event: done`; it throws {@link AtlaSentError} on transport errors or when
   * the server sends `event: error`.
   *
   * The final {@link StreamDecisionEvent} (isFinal: true) carries a `permitId`
   * suitable for passing to {@link verifyPermit} after the stream closes.
   *
   * Hardening:
   * - Throws {@link StreamTimeoutError} when no event arrives within
   *   `opts.timeoutMs` (default 30 s). Pass `0` to disable.
   * - Retries up to `opts.maxRetries` times (default 3) with 1 s / 2 s / 4 s
   *   delays on network drop (before a terminal event). Sends `Last-Event-ID`
   *   on reconnect when the server has emitted event IDs.
   * - Throws {@link StreamParseError} on partial / malformed JSON rather than
   *   crashing with a raw `SyntaxError`.
   * - Closes cleanly on `event: done` or a decision event with `done: true`.
   *
   * ```ts
   * for await (const event of client.protectStream({ agent, action })) {
   *   if (event.type === "decision" && event.isFinal) {
   *     await client.verifyPermit({ permitId: event.permitId });
   *   }
   * }
   * ```
   */
  async *protectStream(
    input: EvaluateRequest,
    opts: StreamOptions = {},
  ): AsyncIterable<StreamEvent> {
    const streamTimeoutMs = opts.timeoutMs ?? 30_000;
    const maxRetries = opts.maxRetries ?? 3;

    const body = {
      action: input.action,
      agent: input.agent,
      context: input.context ?? {},
      api_key: this.apiKey,
    };

    const requestId = globalThis.crypto.randomUUID();
    const url = `${this.baseUrl}/v1-evaluate-stream`;

    let lastEventId: string | undefined;
    let retryCount = 0;

    while (true) {
      const headers: Record<string, string> = {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "User-Agent": this.userAgent,
        "X-Request-ID": requestId,
      };
      if (lastEventId !== undefined) {
        headers["Last-Event-ID"] = lastEventId;
      }

      const connectionTimeoutSignal = AbortSignal.timeout(this.timeoutMs);
      const signal = opts.signal
        ? (
            AbortSignal as unknown as { any(s: AbortSignal[]): AbortSignal }
          ).any([connectionTimeoutSignal, opts.signal])
        : connectionTimeoutSignal;

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        const mapped = mapFetchError(err, requestId);
        if (mapped.code === "network" && retryCount < maxRetries) {
          retryCount++;
          await sleep(1_000 * Math.pow(2, retryCount - 1)); // 1s, 2s, 4s
          continue;
        }
        throw mapped;
      }

      if (!response.ok) {
        throw await buildHttpError(response, requestId);
      }

      if (!response.body) {
        throw new AtlaSentError("Expected streaming body from AtlaSent API", {
          code: "bad_response",
          status: response.status,
          requestId,
        });
      }

      let streamDone = false;
      let networkDrop = false;

      try {
        for await (const event of parseSseStream(
          response.body,
          requestId,
          streamTimeoutMs,
          (id) => {
            lastEventId = id;
          },
        )) {
          yield event;
          if (event.type === "decision" && event.isFinal) {
            streamDone = true;
          }
        }
        // parseSseStream returned normally (saw event: done or stream ended)
        streamDone = true;
      } catch (err) {
        if (err instanceof AtlaSentError && err.code === "network") {
          networkDrop = true;
        } else {
          throw err;
        }
      }

      if (streamDone) break;

      // Network drop before terminal event — attempt reconnect
      if (networkDrop && retryCount < maxRetries) {
        retryCount++;
        await sleep(1_000 * Math.pow(2, retryCount - 1)); // 1s, 2s, 4s
        continue;
      }
      if (networkDrop) {
        throw new AtlaSentError(
          `AtlaSent stream dropped after ${retryCount} reconnection attempts`,
          { code: "network", requestId },
        );
      }
      break;
    }
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
    const qs =
      query && Array.from(query).length > 0 ? `?${query.toString()}` : "";
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
        if (
          isRetryable(httpErr) &&
          hasAttemptsLeft(attempt, this.retryPolicy)
        ) {
          await sleep(computeBackoffMs(attempt, this.retryPolicy, httpErr));
          continue;
        }
        throw httpErr;
      }

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch (err) {
        const jsonErr = new AtlaSentError(
          "Invalid JSON response from AtlaSent API",
          {
            code: "bad_response",
            status: response.status,
            requestId,
            cause: err,
          },
        );
        if (
          isRetryable(jsonErr) &&
          hasAttemptsLeft(attempt, this.retryPolicy)
        ) {
          await sleep(computeBackoffMs(attempt, this.retryPolicy, jsonErr));
          continue;
        }
        throw jsonErr;
      }

      if (parsed === null || typeof parsed !== "object") {
        const shapeErr = new AtlaSentError(
          "Expected a JSON object from AtlaSent API",
          {
            code: "bad_response",
            status: response.status,
            requestId,
          },
        );
        if (
          isRetryable(shapeErr) &&
          hasAttemptsLeft(attempt, this.retryPolicy)
        ) {
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
   * Open a new HITL escalation. Bridges a `hold` outcome from
   * `protect()` to the approval queue: an agent that receives a
   * `hold` decision calls this to enroll the proposed action for
   * human review. The returned escalation can then be polled with
   * `getHitlEscalation()` or driven to terminal by
   * `approveHitlEscalation()` / `rejectHitlEscalation()`.
   *
   * Quorum, pool size, fallback decision and routing inherit from
   * the server-side policy when omitted from `input`.
   *
   * Calls `POST /v1/hitl`.
   */
  async createHitlEscalation(
    input: HitlCreateRequest,
  ): Promise<{ escalation: HitlEscalation; rateLimit: RateLimitState | null }> {
    const { body, rateLimit } = await this.post<HitlEscalation>(
      "/v1/hitl",
      input,
    );
    return { escalation: body, rateLimit };
  }

  /**
   * List HITL escalations for the calling org. Defaults to
   * `status=pending`; pass `status` to query other queues
   * (`escalated`, `approved`, `rejected`, `auto_approved`,
   * `timed_out`).
   *
   * Calls `GET /v1/hitl`.
   */
  async listHitlEscalations(input: ListHitlEscalationsRequest = {}): Promise<{
    data: ListHitlEscalationsResponse;
    rateLimit: RateLimitState | null;
  }> {
    const params = new URLSearchParams();
    if (input.status) params.set("status", input.status);
    if (input.agentId) params.set("agent_id", input.agentId);
    if (input.assignedToUserId)
      params.set("assigned_to_user_id", input.assignedToUserId);
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
      throw new AtlaSentError("escalationId is required", {
        code: "bad_request",
      });
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
  async listHitlApprovals(escalationId: string): Promise<{
    approvals: HitlApprovalRecord[];
    rateLimit: RateLimitState | null;
  }> {
    const { body, rateLimit } = await this.get<{
      approvals: HitlApprovalRecord[];
    }>(`/v1/hitl/${encodeURIComponent(escalationId)}/approvals`);
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
  async getIncidentTimeline(
    incidentId: string,
  ): Promise<IncidentTimelineResponse> {
    if (!incidentId) {
      throw new AtlaSentError("incidentId is required", {
        code: "bad_request",
      });
    }
    const { body, rateLimit } = await this.get<
      Omit<IncidentTimelineResponse, "rateLimit">
    >(`/v1/governance/timeline/incident/${encodeURIComponent(incidentId)}`);
    return { ...body, rateLimit };
  }

  // ── Connector Management ─────────────────────────────────────────────────

  /**
   * List connectors registered for the calling org.
   * Calls `GET /v1/governance/connectors`.
   */
  async listConnectors(
    options: { cursor?: string; limit?: number } = {},
  ): Promise<ListConnectorsResponse> {
    const params = new URLSearchParams();
    if (options.cursor) params.set("cursor", options.cursor);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const { body, rateLimit } = await this.get<{
      connectors: ListConnectorsResponse["connectors"];
      total: number;
      next_cursor?: string;
    }>("/v1/governance/connectors", params);
    const result: ListConnectorsResponse = {
      connectors: body.connectors ?? [],
      total: body.total,
      rateLimit,
    };
    if (body.next_cursor) result.nextCursor = body.next_cursor;
    return result;
  }

  /**
   * Register and install a new connector for the calling org.
   * Calls `POST /v1/governance/connectors`.
   */
  async installConnector(
    input: InstallConnectorInput,
  ): Promise<InstallConnectorResponse> {
    const { body, rateLimit } = await this.post<
      InstallConnectorResponse["connector"]
    >("/v1/governance/connectors", input);
    return { connector: body, rateLimit };
  }

  /**
   * Store encrypted credentials for a connector.
   * Calls `POST /v1/governance/connectors/{id}/authenticate`.
   */
  async authenticateConnector(
    connectorId: string,
    input: AuthenticateConnectorInput,
  ): Promise<AuthenticateConnectorResponse> {
    if (!connectorId) {
      throw new AtlaSentError("connectorId is required", {
        code: "bad_request",
      });
    }
    const { body, rateLimit } = await this.post<{
      credential_id: string;
      version: number;
    }>(
      `/v1/governance/connectors/${encodeURIComponent(connectorId)}/authenticate`,
      input,
    );
    return {
      credential_id: body.credential_id,
      version: body.version,
      rateLimit,
    };
  }

  /**
   * Trigger an incremental sync for a connector.
   * Calls `POST /v1/governance/connectors/{id}/sync`.
   */
  async syncConnector(connectorId: string): Promise<SyncConnectorResponse> {
    if (!connectorId) {
      throw new AtlaSentError("connectorId is required", {
        code: "bad_request",
      });
    }
    const { body, rateLimit } = await this.post<{
      connector_id: string;
      status: SyncConnectorResponse["status"];
      sync_started_at: string;
    }>(`/v1/governance/connectors/${encodeURIComponent(connectorId)}/sync`, {});
    return { ...body, rateLimit };
  }

  /**
   * Revoke a connector and all its associated credentials.
   * Calls `POST /v1/governance/connectors/{id}/revoke`.
   */
  async revokeConnector(
    connectorId: string,
    reason?: string,
  ): Promise<RevokeConnectorResponse> {
    if (!connectorId) {
      throw new AtlaSentError("connectorId is required", {
        code: "bad_request",
      });
    }
    const body: { reason?: string } = {};
    if (reason !== undefined) body.reason = reason;
    const { body: wire, rateLimit } = await this.post<{
      connector_id: string;
      revoked_at: string;
    }>(
      `/v1/governance/connectors/${encodeURIComponent(connectorId)}/revoke`,
      body,
    );
    return { ...wire, rateLimit };
  }

  /**
   * Rotate the credentials for a connector.
   * Calls `POST /v1/governance/connectors/{id}/rotate-credentials`.
   */
  async rotateConnectorCredentials(
    connectorId: string,
  ): Promise<RotateCredentialsResponse> {
    if (!connectorId) {
      throw new AtlaSentError("connectorId is required", {
        code: "bad_request",
      });
    }
    const { body, rateLimit } = await this.post<{
      connector_id: string;
      new_version: number;
      rotated_at: string;
    }>(
      `/v1/governance/connectors/${encodeURIComponent(connectorId)}/rotate-credentials`,
      {},
    );
    return { ...body, rateLimit };
  }

  /**
   * List enforcement policies for the calling org, optionally filtered by connector type.
   * Calls `GET /v1/governance/enforcement-policies`.
   */
  async listEnforcementPolicies(
    connectorType?: ConnectorType,
  ): Promise<ListEnforcementPoliciesResponse> {
    const params = new URLSearchParams();
    if (connectorType) params.set("connector_type", connectorType);
    const { body, rateLimit } = await this.get<{
      policies: ListEnforcementPoliciesResponse["policies"];
      total: number;
    }>("/v1/governance/enforcement-policies", params);
    return { policies: body.policies ?? [], total: body.total, rateLimit };
  }

  /**
   * Create or update a connector enforcement policy.
   * Calls `POST /v1/governance/enforcement-policies`.
   */
  async upsertEnforcementPolicy(
    input: UpsertEnforcementPolicyInput,
  ): Promise<UpsertEnforcementPolicyResponse> {
    const { body, rateLimit } = await this.post<
      UpsertEnforcementPolicyResponse["policy"]
    >("/v1/governance/enforcement-policies", input);
    return { policy: body, rateLimit };
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
    if (params?.permission_type)
      qs.set("permission_type", params.permission_type);
    const { body } = await this.get<{ results: CrossOrgPermissionCheckResult[] }>(
      "/v1/cross-org/permissions",
      qs,
    );
    return body.results ?? [];
  }

  // ── Anomaly Response ──────────────────────────────────────────────────────

  async createAnomalyResponseRule(
    input: CreateAnomalyResponseRuleRequest,
  ): Promise<{ rule: AnomalyResponseRule; rateLimit: RateLimitState | null }> {
    const { body, rateLimit } = await this.post<AnomalyResponseRule>(
      "/v1/anomaly-response/rules",
      input,
    );
    return { rule: body, rateLimit };
  }

  async listAnomalyResponseRules(): Promise<{
    rules: AnomalyResponseRule[];
    rateLimit: RateLimitState | null;
  }> {
    const { body, rateLimit } = await this.get<{ rules: AnomalyResponseRule[] }>(
      "/v1/anomaly-response/rules",
    );
    return { rules: body.rules ?? [], rateLimit };
  }

  async triggerAnomalyResponse(
    input: TriggerAnomalyResponseRequest,
  ): Promise<{ event: AnomalyResponseEvent; rateLimit: RateLimitState | null }> {
    const { body, rateLimit } = await this.post<AnomalyResponseEvent>(
      "/v1/anomaly-response/trigger",
      input,
    );
    return { event: body, rateLimit };
  }

  // ── Budget Exceptions ─────────────────────────────────────────────────────

  async createBudgetException(
    input: CreateBudgetExceptionRequest,
  ): Promise<{ exception: BudgetExceptionRequest; rateLimit: RateLimitState | null }> {
    const { body, rateLimit } = await this.post<BudgetExceptionRequest>(
      "/v1/budget-exceptions",
      input,
    );
    return { exception: body, rateLimit };
  }

  async getBudgetExceptionStatus(
    exceptionId: string,
  ): Promise<{ status: BudgetExceptionStatus; rateLimit: RateLimitState | null }> {
    const { body, rateLimit } = await this.get<BudgetExceptionStatus>(
      `/v1/budget-exceptions/${encodeURIComponent(exceptionId)}/status`,
    );
    return { status: body, rateLimit };
  }

  async approveBudgetException(
    exceptionId: string,
    input: ApproveBudgetExceptionRequest,
  ): Promise<{ exception: BudgetExceptionRequest; rateLimit: RateLimitState | null }> {
    const { body, rateLimit } = await this.post<BudgetExceptionRequest>(
      `/v1/budget-exceptions/${encodeURIComponent(exceptionId)}/approve`,
      input,
    );
    return { exception: body, rateLimit };
  }

  // ── Regulatory Escalations ────────────────────────────────────────────────

  async createRegulatoryEscalation(
    input: CreateRegulatoryEscalationRequest,
  ): Promise<{ escalation: RegulatoryEscalation; rateLimit: RateLimitState | null }> {
    const { body, rateLimit } = await this.post<RegulatoryEscalation>(
      "/v1/regulatory-escalations",
      input,
    );
    return { escalation: body, rateLimit };
  }

  async getRegulatoryEscalationStatus(
    escalationId: string,
  ): Promise<{ status: RegulatoryEscalationStatus; rateLimit: RateLimitState | null }> {
    const { body, rateLimit } = await this.get<RegulatoryEscalationStatus>(
      `/v1/regulatory-escalations/${encodeURIComponent(escalationId)}/status`,
    );
    return { status: body, rateLimit };
  }

  // ── Governance Agents ────────────────────────────────────────────────────

  async listGovernanceAgents(): Promise<ListGovernanceAgentsResponse> {
    const { body, rateLimit } = await this.get<{
      agents: GovernanceAgent[];
      total: number;
    }>("/v1/governance/agents");
    return { agents: body.agents ?? [], total: body.total ?? 0, rateLimit };
  }

  async listGovernanceEvaluations(
    query: ListGovernanceEvaluationsQuery = {},
  ): Promise<ListGovernanceEvaluationsResponse> {
    const params = new URLSearchParams();
    if (query.agentId) params.set("agent_id", query.agentId);
    if (query.status) params.set("status", query.status);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.cursor) params.set("cursor", query.cursor);
    const { body, rateLimit } = await this.get<{
      evaluations: GovernanceAgentEvaluation[];
      total: number;
      next_cursor?: string;
    }>("/v1/governance/evaluations", params);
    const result: ListGovernanceEvaluationsResponse = {
      evaluations: body.evaluations ?? [],
      total: body.total ?? 0,
      rateLimit,
    };
    if (body.next_cursor) result.nextCursor = body.next_cursor;
    return result;
  }

  async listGovernanceFindings(
    query: ListGovernanceFindingsQuery = {},
  ): Promise<ListGovernanceFindingsResponse> {
    const params = new URLSearchParams();
    if (query.agentId) params.set("agent_id", query.agentId);
    if (query.severity) params.set("severity", query.severity);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.cursor) params.set("cursor", query.cursor);
    const { body, rateLimit } = await this.get<{
      findings: GovernanceAgentFinding[];
      total: number;
      next_cursor?: string;
    }>("/v1/governance/findings", params);
    const result: ListGovernanceFindingsResponse = {
      findings: body.findings ?? [],
      total: body.total ?? 0,
      rateLimit,
    };
    if (body.next_cursor) result.nextCursor = body.next_cursor;
    return result;
  }

  // ── Incentive Signal Feedback ─────────────────────────────────────────────

  async recordSignalAction(
    input: RecordSignalActionRequest,
  ): Promise<{ action: SignalActionSummary; rateLimit: RateLimitState | null }> {
    const { body, rateLimit } = await this.post<SignalActionSummary>(
      "/v1/signals/actions",
      input,
    );
    return { action: body, rateLimit };
  }

  async recordSignalOutcome(
    actionId: string,
    input: RecordSignalOutcomeRequest,
  ): Promise<{ action: SignalActionSummary; rateLimit: RateLimitState | null }> {
    const { body, rateLimit } = await this.post<SignalActionSummary>(
      `/v1/signals/actions/${encodeURIComponent(actionId)}/outcome`,
      input,
    );
    return { action: body, rateLimit };
  }

  // ── Cross-Org Impersonation ───────────────────────────────────────────────

  async createImpersonationGrant(
    input: CreateImpersonationGrantRequest,
  ): Promise<{ grant: CrossOrgImpersonationGrant; rateLimit: RateLimitState | null }> {
    const { body, rateLimit } = await this.post<CrossOrgImpersonationGrant>(
      "/v1/cross-org/impersonation/grants",
      input,
    );
    return { grant: body, rateLimit };
  }

  async exchangeImpersonationToken(
    grantId: string,
  ): Promise<{ token: ImpersonationToken; rateLimit: RateLimitState | null }> {
    const { body, rateLimit } = await this.post<ImpersonationToken>(
      `/v1/cross-org/impersonation/grants/${encodeURIComponent(grantId)}/exchange`,
      {},
    );
    return { token: body, rateLimit };
  }

  async validateImpersonationToken(
    token: string,
  ): Promise<{ result: ImpersonationValidationResult; rateLimit: RateLimitState | null }> {
    const { body, rateLimit } = await this.post<ImpersonationValidationResult>(
      "/v1/cross-org/impersonation/validate",
      { token },
    );
    return { result: body, rateLimit };
  }

  // ── Decision Replay ───────────────────────────────────────────────────────

  /**
   * Re-evaluate a prior decision against the current policy bundle to
   * surface drift (ADR-015 §Replay, parity v2).
   *
   * Never throws on a 409 `replay_not_eligible` — returns
   * `ENGINE_DRIFT` or `BUNDLE_MISSING` variance instead.
   *
   * Wire variance mapping:
   *   NONE             → "NONE"          (exact match)
   *   DECISION_CHANGED → "POLICY_DRIFT"  (policy changed outcome)
   *   ENVELOPE_DRIFT   → "ENVELOPE_DRIFT" (envelope hash mismatch)
   *   ENGINE_DRIFT     → "ENGINE_DRIFT"  (retired/unknown engine)
   *   BUNDLE_MISSING   → "BUNDLE_MISSING" (no bundle recorded)
   *   CHAIN_TAMPER     → "CHAIN_TAMPER"  (audit chain tampered)
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
      if (err instanceof AtlaSentError && err.status === 409) {
        const msg = (err.message ?? "").toLowerCase();
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
      rawVariance === "NONE" ? "NONE"
      : rawVariance === "DECISION_CHANGED" ? "POLICY_DRIFT"
      : rawVariance === "ENVELOPE_DRIFT" ? "ENVELOPE_DRIFT"
      : rawVariance === "CHAIN_TAMPER" ? "CHAIN_TAMPER"
      : rawVariance === "BUNDLE_MISSING" ? "BUNDLE_MISSING"
      : rawVariance === "ENGINE_DRIFT" ? "ENGINE_DRIFT"
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
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseRateLimitHeaders(
  headers: Headers,
): RateLimitState | null {
  const limit = headers.get("x-ratelimit-limit");
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  if (limit === null && remaining === null && reset === null) return null;
  return {
    limit: limit !== null ? parseInt(limit, 10) : 0,
    remaining: remaining !== null ? parseInt(remaining, 10) : 0,
    resetAt: reset !== null ? new Date(parseInt(reset, 10) * 1000).toISOString() : new Date().toISOString(),
  };
}

function mapFetchError(err: unknown, requestId: string): AtlaSentError {
  if (err instanceof AtlaSentError) return err;
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      return new AtlaSentError("Request timed out", {
        code: "timeout",
        requestId,
        cause: err,
      });
    }
    return new AtlaSentError(err.message, {
      code: "network",
      requestId,
      cause: err,
    });
  }
  return new AtlaSentError(String(err), { code: "network", requestId });
}

async function buildHttpError(
  response: Response,
  requestId: string,
): Promise<AtlaSentError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const msg =
    body !== null &&
    typeof body === "object" &&
    "message" in body &&
    typeof (body as { message: unknown }).message === "string"
      ? (body as { message: string }).message
      : `HTTP ${response.status}`;
  const code: AtlaSentErrorCode =
    response.status === 401
      ? "invalid_api_key"
      : response.status === 403
        ? "forbidden"
        : response.status === 404
          ? "not_found"
          : response.status === 409
            ? "conflict"
            : response.status === 429
              ? "rate_limited"
              : response.status >= 500
                ? "server_error"
                : "bad_request";
  return new AtlaSentError(msg, { code, status: response.status, requestId, body });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildAuditEventsQuery(query: AuditEventsQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.types) params.set("types", query.types);
  if (query.actorId) params.set("actor_id", query.actorId);
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor) params.set("cursor", query.cursor);
  return params;
}

async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  requestId: string,
  timeoutMs: number,
  onEventId: (id: string) => void,
): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  let lastEventAt = Date.now();

  try {
    while (true) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;

      if (timeoutMs > 0) {
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new StreamTimeoutError(
                  `No SSE event received within ${timeoutMs} ms`,
                  { requestId },
                ),
              ),
            timeoutMs - (Date.now() - lastEventAt),
          ),
        );
        chunk = await Promise.race([reader.read(), timeoutPromise]);
      } else {
        chunk = await reader.read();
      }

      if (chunk.done) break;
      lastEventAt = Date.now();

      buf += decoder.decode(chunk.value, { stream: true });
      const rawBlocks = buf.split("\n\n");
      buf = rawBlocks.pop() ?? "";

      for (const block of rawBlocks) {
        if (!block.trim()) continue;

        // SSE comment / heartbeat
        if (block.trimStart().startsWith(":")) continue;

        let id: string | undefined;
        let eventType = "progress";
        let dataLine = "";

        for (const line of block.split("\n")) {
          if (line.startsWith("id:")) {
            id = line.slice(3).trim();
          } else if (line.startsWith("event:")) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            dataLine = line.slice(5).trim();
          }
        }

        if (id !== undefined) onEventId(id);

        if (eventType === "done") return;

        if (eventType === "error") {
          let errBody: unknown = null;
          try {
            errBody = JSON.parse(dataLine);
          } catch {
            /* empty */
          }
          const errMsg =
            errBody !== null &&
            typeof errBody === "object" &&
            "message" in errBody &&
            typeof (errBody as { message: unknown }).message === "string"
              ? (errBody as { message: string }).message
              : "Stream error from AtlaSent API";
          throw new AtlaSentError(errMsg, {
            code: "server_error",
            requestId,
            body: errBody,
          });
        }

        if (!dataLine) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(dataLine);
        } catch (e) {
          throw new StreamParseError(dataLine, { requestId, cause: e });
        }

        if (parsed === null || typeof parsed !== "object") continue;
        const data = parsed as Record<string, unknown>;

        if (eventType === "progress") {
          yield {
            type: "progress",
            ...(id !== undefined ? { id } : {}),
            message: typeof data.message === "string" ? data.message : "",
            percent:
              typeof data.percent === "number" ? data.percent : undefined,
          } satisfies StreamProgressEvent;
        } else if (eventType === "decision") {
          const rawDecision = typeof data.decision === "string"
            ? data.decision.toLowerCase()
            : undefined;
          const decision = (
            rawDecision === "allow" ||
            rawDecision === "deny" ||
            rawDecision === "hold" ||
            rawDecision === "escalate"
              ? rawDecision
              : "deny"
          ) as DecisionCanonical;
          yield {
            type: "decision",
            ...(id !== undefined ? { id } : {}),
            decision,
            isFinal: data.done === true,
            permitId:
              typeof data.permit_id === "string" ? data.permit_id : undefined,
            reason:
              typeof data.reason === "string" ? data.reason : undefined,
          } satisfies StreamDecisionEvent;
          if (data.done === true) {
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