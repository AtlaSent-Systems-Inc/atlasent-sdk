/**
 * AtlaSent HTTP client.
 *
 * Four public methods, all backed by native `fetch`:
 *   - {@link AtlaSentClient.evaluate}     → POST {baseUrl}/v1-evaluate
 *   - {@link AtlaSentClient.verifyPermit} → POST {baseUrl}/v1-verify-permit
 *   - {@link AtlaSentClient.gate}         → evaluate + verify (throws on deny)
 *   - {@link AtlaSentClient.authorize}    → evaluate (+ optional verify), result-based
 *
 * Fail-closed: a clean policy DENY is returned (not thrown) by
 * `evaluate` and `authorize`, but network, timeout, bad response, 4xx,
 * 5xx, and rate-limit conditions all throw {@link AtlaSentError}.
 * `gate()` throws {@link PermissionDeniedError} on deny so callers can
 * rely on a successful return meaning "verified permit in hand".
 */

import { TTLCache } from "./cache.js";
import {
  AtlaSentError,
  PermissionDeniedError,
  type AtlaSentErrorCode,
  type AtlaSentErrorInit,
} from "./errors.js";
import { noopLogger, type Logger } from "./logger.js";
import type {
  AtlaSentClientOptions,
  AuthorizationResult,
  AuthorizeRequest,
  EvaluateCache,
  EvaluateRequest,
  EvaluateResponse,
  GateResult,
  VerifyPermitRequest,
  VerifyPermitResponse,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.atlasent.io";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BACKOFF_MS = 500;
const SDK_VERSION = "1.2.0";

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
  private readonly maxRetries: number;
  private readonly retryBackoffMs: number;
  private readonly cache: EvaluateCache | undefined;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: AtlaSentClientOptions) {
    if (!options.apiKey || typeof options.apiKey !== "string") {
      throw new AtlaSentError("apiKey is required", {
        code: "invalid_api_key",
      });
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    this.cache = options.cache;
    this.logger = options.logger ?? noopLogger;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep ?? defaultSleep;
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
    const context = input.context ?? {};
    const cacheKey = this.cache
      ? TTLCache.makeKey(input.action, input.agent, context)
      : undefined;

    if (this.cache && cacheKey) {
      const hit = this.cache.get(cacheKey);
      if (hit !== undefined) {
        this.logger.debug("evaluate cache hit", {
          cacheKey,
          agent: input.agent,
          action: input.action,
        });
        return hit;
      }
    }

    this.logger.debug("evaluate", { agent: input.agent, action: input.action });
    const body = {
      action: input.action,
      agent: input.agent,
      context,
      api_key: this.apiKey,
    };
    const wire = await this.post<EvaluateWire>("/v1-evaluate", body);

    if (typeof wire.permitted !== "boolean" || typeof wire.decision_id !== "string") {
      throw new AtlaSentError(
        "Malformed response from /v1-evaluate: missing `permitted` or `decision_id`",
        { code: "bad_response" },
      );
    }

    const result: EvaluateResponse = {
      decision: wire.permitted ? "ALLOW" : "DENY",
      permitId: wire.decision_id,
      reason: wire.reason ?? "",
      auditHash: wire.audit_hash ?? "",
      timestamp: wire.timestamp ?? "",
    };

    if (result.decision === "ALLOW") {
      this.logger.info("evaluate permitted", {
        agent: input.agent,
        action: input.action,
        permitId: result.permitId,
      });
      // Only cache permits: caching a DENY would block legitimate
      // re-evaluation after policy changes.
      if (this.cache && cacheKey) this.cache.put(cacheKey, result);
    } else {
      this.logger.warn("evaluate denied", {
        agent: input.agent,
        action: input.action,
        permitId: result.permitId,
        reason: result.reason,
      });
    }

    return result;
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
    const wire = await this.post<VerifyPermitWire>(
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
    };
  }

  /**
   * Evaluate then verify — the happy-path shortcut.
   *
   * Throws {@link PermissionDeniedError} on deny so a successful
   * return always carries a verified permit.
   */
  async gate(input: EvaluateRequest): Promise<GateResult> {
    const context = input.context ?? {};
    const evaluation = await this.evaluate({ ...input, context });
    if (evaluation.decision === "DENY") {
      throw new PermissionDeniedError({
        permitId: evaluation.permitId,
        reason: evaluation.reason,
      });
    }
    const verification = await this.verifyPermit({
      permitId: evaluation.permitId,
      action: input.action,
      agent: input.agent,
      context,
    });
    return { evaluation, verification };
  }

  /**
   * Authorize an agent action — the one-call public API.
   *
   * Unlike {@link gate}, this method does **not** throw on deny by
   * default: inspect `result.permitted`. Network, rate-limit,
   * invalid-key, and server errors always throw.
   *
   * Pass `raiseOnDeny: true` to get exception-based flow at call
   * sites that prefer try/catch.
   */
  async authorize(input: AuthorizeRequest): Promise<AuthorizationResult> {
    const context = input.context ?? {};
    const verify = input.verify ?? true;
    const raiseOnDeny = input.raiseOnDeny ?? false;

    const evaluation = await this.evaluate({
      agent: input.agent,
      action: input.action,
      context,
    });

    if (evaluation.decision === "DENY") {
      if (raiseOnDeny) {
        throw new PermissionDeniedError({
          permitId: evaluation.permitId,
          reason: evaluation.reason,
        });
      }
      return {
        permitted: false,
        agent: input.agent,
        action: input.action,
        context,
        reason: evaluation.reason,
        permitId: evaluation.permitId,
        auditHash: "",
        permitHash: "",
        verified: false,
        timestamp: evaluation.timestamp,
      };
    }

    let permitHash = "";
    let verified = false;
    if (verify) {
      const v = await this.verifyPermit({
        permitId: evaluation.permitId,
        action: input.action,
        agent: input.agent,
        context,
      });
      permitHash = v.permitHash;
      verified = v.verified;
    }

    return {
      permitted: true,
      agent: input.agent,
      action: input.action,
      context,
      reason: evaluation.reason,
      permitId: evaluation.permitId,
      auditHash: evaluation.auditHash,
      permitHash,
      verified,
      timestamp: evaluation.timestamp,
    };
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const serialized = JSON.stringify(body);
    let lastTransient: AtlaSentError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
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
          body: serialized,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        const mapped = mapFetchError(err, requestId);
        if (shouldRetry(mapped.code) && attempt < this.maxRetries) {
          lastTransient = mapped;
          this.logger.warn("request retrying", {
            path,
            attempt: attempt + 1,
            maxAttempts: 1 + this.maxRetries,
            code: mapped.code,
            requestId,
          });
          await this.sleep(this.retryBackoffMs * 2 ** attempt);
          continue;
        }
        throw mapped;
      }

      if (!response.ok) {
        const httpError = await buildHttpError(response, requestId);
        if (shouldRetry(httpError.code) && attempt < this.maxRetries) {
          lastTransient = httpError;
          this.logger.warn("request retrying", {
            path,
            attempt: attempt + 1,
            maxAttempts: 1 + this.maxRetries,
            status: httpError.status,
            code: httpError.code,
            requestId,
          });
          await this.sleep(this.retryBackoffMs * 2 ** attempt);
          continue;
        }
        throw httpError;
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

      return parsed as T;
    }

    // Exhausted retries with nothing but transient failures.
    throw (
      lastTransient ??
      new AtlaSentError(`Request to ${path} failed after retries`, {
        code: "network",
      })
    );
  }
}

function shouldRetry(code: AtlaSentErrorCode | undefined): boolean {
  return code === "server_error" || code === "timeout" || code === "network";
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
