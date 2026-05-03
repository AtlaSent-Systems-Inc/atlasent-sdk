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
  RateLimitState,
  RevokePermitRequest,
  RevokePermitResponse,
  StreamDecisionEvent,
  StreamEvent,
  StreamProgressEvent,
  VerifyPermitRequest,
  VerifyPermitResponse,
} from "./types.js";
import {
  normalizeEvaluateRequest,
  type LegacyEvaluateRequest,
  type V2EvaluateRequest,
} from "./compat.js";

const DEFAULT_BASE_URL = "https://api.atlasent.io";
const DEFAULT_TIMEOUT_MS = 10_000;
const SDK_VERSION = "1.6.0";

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
 */
function _enforceTls(baseUrl: string): string {
  const allow =
    (typeof process !== "undefined" &&
      process?.env?.ATLASENT_ALLOW_INSECURE_HTTP === "1") ||
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
   * A "DENY" is **not** thrown — it is returned in
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

    // Tolerate both canonical {decision, permit_token} and legacy
    // {permitted, decision_id} server responses.
    let decision = wire.decision;
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
      decision: decision === "allow" ? "ALLOW" : "DENY",
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

    let decision = wire.decision;
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
      decision: decision === "allow" ? "ALLOW" : "DENY",
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
    opts: { signal?: AbortSignal } = {},
  ): AsyncIterable<StreamEvent> {
    const body = {
      action: input.action,
      agent: input.agent,
      context: input.context ?? {},
      api_key: this.apiKey,
    };

    const requestId = globalThis.crypto.randomUUID();
    const url = `${this.baseUrl}/v1-evaluate-stream`;
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      "User-Agent": this.userAgent,
      "X-Request-ID": requestId,
    };

    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = opts.signal
      ? (AbortSignal as unknown as { any(s: AbortSignal[]): AbortSignal }).any([
          timeoutSignal,
          opts.signal,
        ])
      : timeoutSignal;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw mapFetchError(err, requestId);
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

    yield* parseSseStream(response.body, requestId);
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

    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      "User-Agent": this.userAgent,
      "X-Request-ID": requestId,
    };
    if (method === "POST") headers["Content-Type"] = "application/json";

    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (method === "POST") init.body = JSON.stringify(body);

    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (err) {
      throw mapFetchError(err, requestId);
    }

    if (!response.ok) {
      throw await buildHttpError(response, requestId);
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (err) {
      throw new AtlaSentError("Invalid JSON response from AtlaSent API", {
        code: "bad_response",
        status: response.status,
        requestId,
        cause: err,
      });
    }

    if (parsed === null || typeof parsed !== "object") {
      throw new AtlaSentError("Expected a JSON object from AtlaSent API", {
        code: "bad_response",
        status: response.status,
        requestId,
      });
    }

    return {
      body: parsed as T,
      rateLimit: parseRateLimitHeaders(response.headers),
    };
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

async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  requestId: string,
): AsyncIterable<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let boundary: number;
      while ((boundary = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, boundary);
        buf = buf.slice(boundary + 2);

        let eventType = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) eventType = line.slice(7).trim();
          else if (line.startsWith("data: ")) data = line.slice(6);
        }

        if (!data) continue;
        if (eventType === "done") return;

        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          throw new AtlaSentError("Malformed SSE data from AtlaSent API", {
            code: "bad_response",
            requestId,
          });
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
          };
          if (typeof d.permitted !== "boolean" || typeof d.decision_id !== "string") {
            throw new AtlaSentError("Malformed decision event from AtlaSent API", {
              code: "bad_response",
              requestId,
            });
          }
          yield {
            type: "decision",
            decision: d.permitted ? "ALLOW" : "DENY",
            permitId: d.decision_id,
            reason: d.reason ?? "",
            auditHash: d.audit_hash ?? "",
            timestamp: d.timestamp ?? "",
            isFinal: d.is_final ?? false,
          } satisfies StreamDecisionEvent;
        } else if (eventType === "progress") {
          const p = parsed as Record<string, unknown>;
          yield { type: "progress", stage: String(p["stage"] ?? ""), ...p } satisfies StreamProgressEvent;
        }
        // Unknown event types skipped for forward compatibility.
      }
    }
  } finally {
    reader.releaseLock();
  }
}
