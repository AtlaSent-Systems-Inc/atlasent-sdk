/**
 * AtlaSent HTTP client — v1.1
 *
 * Public methods:
 *   - {@link AtlaSentClient.evaluate}      → POST /v1/evaluate
 *   - {@link AtlaSentClient.verifyPermit}  → POST /v1/permits/:id/verify
 *   - {@link AtlaSentClient.consumePermit} → POST /v1/permits/:id/consume
 *   - {@link AtlaSentClient.getSession}    → GET  /v1/session
 *
 * Fail-closed: a clean policy deny is returned (not thrown), but
 * network, timeout, bad response, 4xx/5xx, and rate-limit conditions
 * all throw {@link AtlaSentError}.
 *
 * OTel tracing: pass `options.tracing.tracer` to wrap evaluate() in a
 * span named `atlasent.evaluate`.
 */

import {
  AtlaSentError,
  type AtlaSentErrorCode,
  type AtlaSentErrorInit,
} from './errors.js';
import type {
  EvaluationPayload,
  EvaluationResult,
  Decision,
} from '@atlasent/types';
import { withSpan, type TracingOptions } from './otel.js';

const DEFAULT_BASE_URL = 'https://api.atlasent.io';
const DEFAULT_TIMEOUT_MS = 10_000;
const SDK_VERSION = '1.1.0';

export interface AtlaSentClientOptions {
  /** Required. Your AtlaSent API key. */
  apiKey: string;
  /** API base URL. Defaults to "https://api.atlasent.io". */
  apiUrl?: string;
  /** Per-request timeout in milliseconds. Defaults to 10_000. */
  timeoutMs?: number;
  /**
   * Inject a fetch implementation (primarily for testing).
   * Defaults to `globalThis.fetch`.
   */
  fetch?: typeof fetch;
  /** OpenTelemetry tracing options. */
  tracing?: TracingOptions;
}

export class AtlaSentClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly tracing: TracingOptions | undefined;

  constructor(options: AtlaSentClientOptions) {
    if (!options.apiKey || typeof options.apiKey !== 'string') {
      throw new AtlaSentError('apiKey is required', { code: 'invalid_api_key' });
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.apiUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.tracing = options.tracing;
  }

  /**
   * Ask the policy engine whether an action is permitted.
   *
   * A "deny" outcome is **not** thrown — it is returned in
   * `result.outcome`. Network errors, invalid API key, rate limits,
   * timeouts, and malformed responses throw {@link AtlaSentError}.
   *
   * If `options.tracing.tracer` is provided, the call is wrapped in
   * an OTel span named `atlasent.evaluate` with attributes:
   *   - `action.id`
   *   - `decision.outcome`
   *   - `risk.level`
   */
  async evaluate(payload: EvaluationPayload): Promise<EvaluationResult> {
    return withSpan(
      this.tracing?.tracer,
      'atlasent.evaluate',
      {
        'action.id': payload.action?.id ?? '',
      },
      async () => {
        const result = await this.post<EvaluationResult>('/v1/evaluate', payload);
        return result;
      },
    );
  }

  /**
   * Verify that a previously issued permit is still valid.
   * POST /v1/permits/:id/verify
   */
  async verifyPermit(id: string): Promise<unknown> {
    return this.post<unknown>(`/v1/permits/${encodeURIComponent(id)}/verify`, {});
  }

  /**
   * Consume a permit, marking it as used.
   * POST /v1/permits/:id/consume
   */
  async consumePermit(id: string): Promise<unknown> {
    return this.post<unknown>(`/v1/permits/${encodeURIComponent(id)}/consume`, {});
  }

  /**
   * Retrieve current session information.
   * GET /v1/session
   */
  async getSession(): Promise<unknown> {
    return this.get<unknown>('/v1/session');
  }

  // ---------------------------------------------------------------------------
  // Internal HTTP helpers
  // ---------------------------------------------------------------------------

  private buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      'User-Agent': `@atlasent/sdk/${SDK_VERSION} node/${typeof process !== 'undefined' ? process.version : 'unknown'}`,
      'X-Request-ID': globalThis.crypto.randomUUID(),
      'X-AtlaSent-Key': this.apiKey,
    };
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers = this.buildHeaders();
    const requestId = headers['X-Request-ID'];

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
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

    return parseJsonResponse<T>(response, requestId);
  }

  private async get<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers = this.buildHeaders();
    const requestId = headers['X-Request-ID'];

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw mapFetchError(err, requestId);
    }

    if (!response.ok) {
      throw await buildHttpError(response, requestId);
    }

    return parseJsonResponse<T>(response, requestId);
  }
}

// ---------------------------------------------------------------------------
// HTTP error helpers (package-private)
// ---------------------------------------------------------------------------

async function parseJsonResponse<T>(response: Response, requestId: string): Promise<T> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (err) {
    throw new AtlaSentError('Invalid JSON response from AtlaSent API', {
      code: 'bad_response',
      status: response.status,
      requestId,
      cause: err,
    });
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new AtlaSentError('Expected a JSON object from AtlaSent API', {
      code: 'bad_response',
      status: response.status,
      requestId,
    });
  }
  return parsed as T;
}

function mapFetchError(err: unknown, requestId: string): AtlaSentError {
  if (err instanceof AtlaSentError) return err;
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return new AtlaSentError('Request to AtlaSent API timed out', {
      code: 'timeout',
      requestId,
      cause: err,
    });
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return new AtlaSentError('Request to AtlaSent API timed out', {
      code: 'timeout',
      requestId,
      cause: err,
    });
  }
  const message = err instanceof Error ? err.message : 'network error';
  return new AtlaSentError(`Failed to reach AtlaSent API: ${message}`, {
    code: 'network',
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
    return { message: serverMessage ?? 'Invalid API key', code: 'invalid_api_key', retryAfterMs: undefined };
  }
  if (status === 403) {
    return { message: serverMessage ?? 'Access forbidden — check your API key permissions', code: 'forbidden', retryAfterMs: undefined };
  }
  if (status === 429) {
    return {
      message: serverMessage ?? 'Rate limited by AtlaSent API',
      code: 'rate_limited',
      retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
    };
  }
  if (status >= 500) {
    return { message: serverMessage ?? `AtlaSent API returned HTTP ${status}`, code: 'server_error', retryAfterMs: undefined };
  }
  return { message: serverMessage ?? `AtlaSent API returned HTTP ${status}`, code: 'bad_request', retryAfterMs: undefined };
}

async function readServerMessage(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    if (!text) return null;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        const msg = (parsed as Record<string, unknown>).message;
        const reason = (parsed as Record<string, unknown>).reason;
        if (typeof msg === 'string' && msg.length > 0) return msg;
        if (typeof reason === 'string' && reason.length > 0) return reason;
      }
    } catch {
      // fall through
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
