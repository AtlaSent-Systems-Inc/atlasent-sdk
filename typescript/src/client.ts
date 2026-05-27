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
import type { ReplayDecisionResponse } from "./replay.js";
import type {
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
  Decision,
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
import {
  makeScimClient,
  type ScimSubClient,
} from "./scim.js";
import {
  makeEvidenceBundleClient,
  type EvidenceBundleSubClient,
} from "./evidence-bundle.js";
import {
  makeAuthClient,
  type AuthSubClient,
} from "./auth.js";

const DEFAULT_BASE_URL = "https://api.atlasent.io";
const DEFAULT_TIMEOUT_MS = 10_000;
const SDK_VERSION = "2.10.0";
const V1_EVALUATE_BATCH_PATH = "/v1/evaluate/batch";
const V1_EVALUATE_BATCH_LEGACY_PATH = "/v1-evaluate-batch";
const V1_EVALUATE_STREAM_PATH = "/v1/evaluate/stream";
const V1_EVALUATE_STREAM_LEGACY_PATH = "/v1-evaluate-stream";

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
  // Legacy: present on older deployments where the handler emitted
  // `permitted: true/false` instead of `decision: "allow"/"deny"`.
  permitted?: boolean;
  decision_id?: string;
  request_id?: string;
  expires_at?: string;
  denial?: {
    reason?: string;
    code?: string;
  };
  // Canonical v2 deny shape.
  reason?: string;
  deny_code?: string;
  constraint_traces?: ConstraintTrace[];
  rate_limit_state?: {
    limit: number;
    remaining: number;
    reset_at: string;
  };
}

interface EvaluateBatchWire {
  results: EvaluateBatchResultItem[];
}

/**
 * Raw JSON shape received from `POST /v1-verify-permit`.
 *
 * Canonical fields:
 *   valid: boolean
 *   outcome: "allow" | "deny"
 *   verify_error_code?: string
 *   reason?: string
 *   expires_at?: string | null
 *
 * Legacy `verified` kept for backward-compat with older deployments.
 */
interface VerifyPermitWire {
  valid: boolean;
  outcome: "allow" | "deny";
  verify_error_code?: string;
  reason?: string;
  expires_at?: string | null;
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

  /** SCIM 2.0 provisioning sub-client. Access as `client.scim`. */
  readonly scim: ScimSubClient;
  /** Evidence bundle sub-client. Access as `client.evidenceBundles`. */
  readonly evidenceBundles: EvidenceBundleSubClient;
  /** Auth / token management sub-client. Access as `client.auth`. */
  readonly auth: AuthSubClient;

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
    this.scim = makeScimClient(
      (path, body, query) => this._post(path, body, query),
      (path, query) => this._get(path, query),
      (path, body) => this._put(path, body),
      (path) => this._delete(path),
    );
    this.evidenceBundles = makeEvidenceBundleClient(
      (path, body) => this._post(path, body),
      (path, query) => this._get(path, query),
      (path) => this._getRaw(path),
    );
    this.auth = makeAuthClient(
      (path, body) => this._post(path, body),
      (path) => this._get(path),
    );
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

    const body: Record<string, unknown> = {
      action_type: normalized.action_type,
      actor_id: normalized.actor_id,
      context: normalized.context ?? {},
    };
    if (normalized.explain !== undefined) body.explain = normalized.explain;
    const { body: wire, rateLimit } = await this.post<EvaluateWire>(
      "/v1/evaluate",
      body,
    );

    // Unify canonical vs legacy wire shape.
    const decision: DecisionCanonical = (() => {
      if (wire.decision === "allow" || wire.decision === "deny") {
        return wire.decision;
      }
      if (wire.decision === "hold") return "hold";
      if (wire.decision === "escalate") return "escalate";
      // Legacy fallback.
      return wire.permitted ? "allow" : "deny";
    })();

    const permitToken: string | undefined =
      wire.permit_token ?? wire.decision_id;

    const constraintTraces = wire.constraint_traces ?? [];

    return {
      decision,
      permitToken,
      requestId: wire.request_id,
      expiresAt: wire.expires_at,
      denial: wire.denial
        ? {
            reason: wire.denial.reason ?? "",
            code: wire.denial.code ?? "policy_deny",
          }
        : wire.reason
          ? { reason: wire.reason, code: wire.deny_code ?? "policy_deny" }
          : undefined,
      constraintTraces,
      rateLimit,
    };
  }

  /**
   * Preflight check: returns the evaluation result **without** minting a
   * permit token. Useful for dry-run checks in dashboards or test suites
   * where you want to know what the policy engine would decide without
   * the cost of issuing a real permit.
   *
   * Calls `POST /v1/evaluate/preflight`.
   */
  async evaluatePreflight(
    input: EvaluateRequest | LegacyEvaluateRequest,
  ): Promise<EvaluatePreflightResponse> {
    _warnOversizeContext(input.context);
    const normalized = normalizeEvaluateRequest(
      input as LegacyEvaluateRequest | V2EvaluateRequest,
    );
    const body: Record<string, unknown> = {
      action_type: normalized.action_type,
      actor_id: normalized.actor_id,
      context: normalized.context ?? {},
    };
    if (normalized.explain !== undefined) body.explain = normalized.explain;
    const { body: wire } = await this.post<EvaluatePreflightResponse>(
      "/v1/evaluate/preflight",
      body,
    );
    return wire;
  }

  /**
   * Evaluate a batch of actions in a single round-trip.
   *
   * Accepts up to `batchSizeLimit` items per request (enforced by the
   * server; default 100). Results are returned in the same order as
   * the input items.
   *
   * The method tries `POST /v1/evaluate/batch` first and falls back to
   * the legacy `POST /v1-evaluate-batch` path on 404 or 405 so callers
   * can use this against both current and older atlasent-api deployments
   * without configuration.
   */
  async evaluateBatch(
    items: BatchEvalItem[],
    options?: { batchSizeLimit?: number },
  ): Promise<BatchEvalResponse> {
    const limit = options?.batchSizeLimit ?? 100;
    if (items.length > limit) {
      throw new AtlaSentError(
        `evaluateBatch: input has ${items.length} items; ` +
          `batch limit is ${limit}`,
        { code: "bad_request" },
      );
    }
    const { body: wire, rateLimit } =
      await this.postWithPathFallback<EvaluateBatchWire>(
        V1_EVALUATE_BATCH_PATH,
        V1_EVALUATE_BATCH_LEGACY_PATH,
        { items },
      );
    return {
      results: wire.results ?? [],
      rateLimit,
    };
  }

  /**
   * Subscribe to a real-time decision stream.
   *
   * Opens a persistent SSE connection to `GET /v1-decisions-stream` and
   * yields typed {@link StreamEvent} objects until the stream closes or
   * `options.signal` is aborted.
   *
   * **Reconnection behaviour** (Node.js only):
   * Up to `options.maxReconnects` (default 3) automatic reconnections are
   * attempted on transient drops. Each reconnect delay doubles from 1 s
   * (`1s → 2s → 4s`). The `Last-Event-ID` header is sent on reconnects
   * to resume from the last received event. Browser callers receive no
   * reconnect logic — use the native `EventSource` API instead.
   *
   * Network errors, unexpected server closures beyond the reconnect limit,
   * or any event that cannot be parsed as JSON throw {@link AtlaSentError}
   * (code `"network"` or `"bad_response"`).
   */
  async *subscribeDecisions(
    options: SubscribeDecisionsOptions,
  ): AsyncGenerator<StreamEvent> {
    const url = new URL(`${this.baseUrl}/v1-decisions-stream`);
    if (options.agentId) url.searchParams.set("agent_id", options.agentId);
    if (options.orgId) url.searchParams.set("org_id", options.orgId);

    const maxReconnects = options.maxReconnects ?? 3;
    let lastEventId: string | undefined;
    let reconnectCount = 0;

    while (true) {
      const headers: Record<string, string> = {
        Accept: "text/event-stream",
        Authorization: `Bearer ${this.apiKey}`,
        "User-Agent": this.userAgent,
        "Cache-Control": "no-cache",
      };
      if (lastEventId !== undefined) {
        headers["Last-Event-ID"] = lastEventId;
      }

      let response: Response;
      try {
        response = await this.fetchImpl(url.toString(), {
          method: "GET",
          headers,
          signal: options.signal,
        });
      } catch (err) {
        if (
          err instanceof Error &&
          (err.name === "AbortError" || err.name === "TimeoutError")
        ) {
          return;
        }
        throw new AtlaSentError(
          `Network error connecting to decision stream: ${String(err)}`,
          { code: "network", cause: err },
        );
      }

      if (!response.ok) {
        const errBody = await response
          .text()
          .catch(() => `HTTP ${response.status}`);
        throw new AtlaSentError(
          `Decision stream returned HTTP ${response.status}: ${errBody}`,
          { code: "server_error", status: response.status },
        );
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new AtlaSentError(
          "Decision stream response has no body",
          { code: "bad_response" },
        );
      }

      let networkDrop = false;
      try {
        yield* this._parseEventStream(
          reader,
          options,
          (id) => { lastEventId = id; },
        );
        // Clean close — stop retrying.
        return;
      } catch (err) {
        if (
          err instanceof Error &&
          (err.name === "AbortError" || err.name === "TimeoutError")
        ) {
          return;
        }
        // Network drop during stream — eligible for reconnect in Node.
        if (
          isNode &&
          err instanceof AtlaSentError &&
          err.code === "network" &&
          reconnectCount < maxReconnects
        ) {
          reconnectCount++;
          networkDrop = true;
        } else {
          throw err;
        }
      } finally {
        reader.cancel().catch(() => { /* ignore */ });
      }

      if (networkDrop) {
        await sleep(1_000 * Math.pow(2, reconnectCount - 1)); // 1s, 2s, 4s
        continue;
      }
      if (networkDrop) {
        throw new AtlaSentError(
          `AtlaSent stream dropped after ${reconnectCount} reconnection attempts`,
          { code: "network" },
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

  private async postWithPathFallback<T>(
    primaryPath: string,
    fallbackPath: string,
    body: unknown,
    query?: URLSearchParams,
  ): Promise<{ body: T; rateLimit: RateLimitState | null }> {
    try {
      return await this.post<T>(primaryPath, body, query);
    } catch (err) {
      if (
        err instanceof AtlaSentError &&
        (err.status === 404 || err.status === 405)
      ) {
        return this.post<T>(fallbackPath, body, query);
      }
      throw err;
    }
  }

  private async get<T>(
    path: string,
    query?: URLSearchParams,
  ): Promise<{ body: T; rateLimit: RateLimitState | null }> {
    return this.request<T>(path, "GET", undefined, query);
  }

  // ── Sub-client adapters ────────────────────────────────────────────────────
  // Thin wrappers that expose the private request infrastructure to sub-client
  // factories (scim, evidenceBundles, auth) without widening the public API.

  private async _post<T>(
    path: string,
    body: unknown,
    query?: URLSearchParams,
  ): Promise<{ body: T }> {
    const { body: b } = await this.post<T>(path, body, query);
    return { body: b };
  }

  private async _get<T>(
    path: string,
    query?: URLSearchParams,
  ): Promise<{ body: T }> {
    const { body: b } = await this.get<T>(path, query);
    return { body: b };
  }

  private async _put<T>(
    path: string,
    body: unknown,
  ): Promise<{ body: T }> {
    return this.requestRaw<T>(path, "PUT", body, undefined);
  }

  private async _delete(path: string): Promise<void> {
    await this.requestRaw<Record<string, unknown>>(path, "DELETE", undefined, undefined);
  }

  private async _getRaw(path: string): Promise<ArrayBuffer> {
    const url = `${this.baseUrl}${path}`;
    const requestId = globalThis.crypto.randomUUID();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "User-Agent": this.userAgent,
      "X-Request-ID": requestId,
      "X-AtlaSent-Protocol-Version": "1",
    };
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw await buildHttpError(response, requestId);
    }
    return response.arrayBuffer();
  }

  private async requestRaw<T>(
    path: string,
    method: "PUT" | "DELETE",
    body: unknown,
    query: URLSearchParams | undefined,
  ): Promise<{ body: T }> {
    const qs =
      query && Array.from(query).length > 0 ? `?${query.toString()}` : "";
    const url = `${this.baseUrl}${path}${qs}`;
    const requestId = globalThis.crypto.randomUUID();
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      "User-Agent": this.userAgent,
      "X-Request-ID": requestId,
      "X-AtlaSent-Protocol-Version": "1",
    };
    if (method === "PUT" && body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    const bodyStr =
      (method === "PUT" && body !== undefined) ? JSON.stringify(body) : undefined;
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
    if (bodyStr !== undefined) init.body = bodyStr;
    const response = await this.fetchImpl(url, init);
    if (!response.ok) {
      throw await buildHttpError(response, requestId);
    }
    if (method === "DELETE") {
      return { body: {} as T };
    }
    const parsed = await response.json() as T;
    return { body: parsed };
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
      // ADR-025: wire-protocol version declared on every request.
      "X-AtlaSent-Protocol-Version": "1",
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