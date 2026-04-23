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

import {
  AtlaSentError,
  type AtlaSentErrorCode,
  type AtlaSentErrorInit,
} from "./errors.js";
import type {
  AtlaSentClientOptions,
  EvaluateRequest,
  EvaluateResponse,
  RateLimitState,
  VerifyPermitRequest,
  VerifyPermitResponse,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.atlasent.io";
const DEFAULT_TIMEOUT_MS = 10_000;
const SDK_VERSION = "0.1.0";

/** Raw JSON shape received from `POST /v1-evaluate`. */
interface EvaluateWire {
  permitted: boolean;
  decision_id: string;
  reason?: string;
  audit_hash?: string;
  timestamp?: string;
}

/** Raw JSON shape received from `POST /v1-verify-permit`. */
interface VerifyPermitWire {
  verified: boolean;
  outcome?: string;
  permit_hash?: string;
  timestamp?: string;
}

export class AtlaSentClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AtlaSentClientOptions) {
    if (!options.apiKey || typeof options.apiKey !== "string") {
      throw new AtlaSentError("apiKey is required", {
        code: "invalid_api_key",
      });
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Ask the policy engine whether an agent action is permitted.
   *
   * A "DENY" is **not** thrown — it is returned in
   * `response.decision`. Network errors, invalid API key, rate
   * limits, timeouts, and malformed responses throw
   * {@link AtlaSentError}.
   */
  async evaluate(input: EvaluateRequest): Promise<EvaluateResponse> {
    const body = {
      action: input.action,
      agent: input.agent,
      context: input.context ?? {},
      api_key: this.apiKey,
    };
    const { body: wire, rateLimit } = await this.post<EvaluateWire>("/v1-evaluate", body);

    if (typeof wire.permitted !== "boolean" || typeof wire.decision_id !== "string") {
      throw new AtlaSentError(
        "Malformed response from /v1-evaluate: missing `permitted` or `decision_id`",
        { code: "bad_response" },
      );
    }

    return {
      decision: wire.permitted ? "ALLOW" : "DENY",
      permitId: wire.decision_id,
      reason: wire.reason ?? "",
      auditHash: wire.audit_hash ?? "",
      timestamp: wire.timestamp ?? "",
      rateLimit,
    };
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
    const body = {
      decision_id: input.permitId,
      action: input.action ?? "",
      agent: input.agent ?? "",
      context: input.context ?? {},
      api_key: this.apiKey,
    };
    const { body: wire, rateLimit } = await this.post<VerifyPermitWire>(
      "/v1-verify-permit",
      body,
    );

    if (typeof wire.verified !== "boolean") {
      throw new AtlaSentError(
        "Malformed response from /v1-verify-permit: missing `verified`",
        { code: "bad_response" },
      );
    }

    return {
      verified: wire.verified,
      outcome: wire.outcome ?? "",
      permitHash: wire.permit_hash ?? "",
      timestamp: wire.timestamp ?? "",
      rateLimit,
    };
  }

  private async post<T>(
    path: string,
    body: unknown,
  ): Promise<{ body: T; rateLimit: RateLimitState | null }> {
    const url = `${this.baseUrl}${path}`;
    const requestId = globalThis.crypto.randomUUID();

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      "User-Agent": `@atlasent/sdk/${SDK_VERSION} node/${process.version}`,
      "X-Request-ID": requestId,
    };

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
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
  // Attach full rate-limit state to 429s so consumers can inspect
  // which budget was blown (`limit`) and when it resets (`resetAt`)
  // alongside the simpler `retryAfterMs` delay. Passing through on
  // other 4xx / 5xx too — the server emits the headers uniformly
  // on every authed response.
  const rateLimit = parseRateLimitHeaders(response.headers);
  if (rateLimit !== null) {
    init.rateLimit = rateLimit;
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
