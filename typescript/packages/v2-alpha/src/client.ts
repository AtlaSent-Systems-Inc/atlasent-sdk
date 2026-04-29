/**
 * V2 HTTP client — minimal, fetch-based.
 *
 * Surfaces the v2 lifecycle methods that the alpha pack ships:
 *   - consume()     — close a permit lifecycle with a proof
 *   - verifyProof() — server-side verification of an emitted proof
 *
 * Future PRs in the v2-alpha series add evaluateBatch() and
 * subscribeDecisions(). Each method returns a wire-typed object
 * that mirrors the corresponding v2 schema in
 * `contract/schemas/v2/`.
 */

import type {
  BatchEvaluateItem,
  ConsumeRequest,
  ConsumeResponse,
  DecisionEvent,
  EvaluateBatchRequest,
  EvaluateBatchResponse,
  ProofVerificationResult,
} from "./types.js";
import { parseSSE } from "./sse.js";

const DEFAULT_BASE_URL = "https://api.atlasent.io";
const DEFAULT_TIMEOUT_MS = 10_000;

/** Construction options for {@link V2Client}. */
export interface V2ClientOptions {
  /** AtlaSent API key (required). */
  apiKey: string;
  /** Override the default `https://api.atlasent.io`. */
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Defaults to 10s. */
  timeoutMs?: number;
  /** Inject a custom fetch (primarily for tests). */
  fetch?: typeof fetch;
}

/** Input to {@link V2Client.consume}. `api_key` is filled in by the client. */
export interface ConsumeInput {
  permitId: string;
  payloadHash: string;
  executionStatus: ConsumeRequest["execution_status"];
  /** Optional SHA-256 hex of execution-result metadata. */
  executionHash?: string;
}

/** Thrown for any non-2xx response, network failure, or timeout. */
export class V2Error extends Error {
  override readonly name = "V2Error";
  readonly status?: number;
  readonly code?: string;
  readonly responseBody?: unknown;

  constructor(
    message: string,
    init?: { status?: number; code?: string; responseBody?: unknown },
  ) {
    super(message);
    this.status = init?.status;
    this.code = init?.code;
    this.responseBody = init?.responseBody;
  }
}

/**
 * Minimal v2 HTTP client. Uses native `fetch` (Node 20+, modern browsers,
 * Cloudflare Workers, Deno, Bun). Call {@link consume} after running the
 * wrapped callback; call {@link verifyProof} to confirm a proof on the
 * server.
 */
export class V2Client {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: V2ClientOptions) {
    if (!options.apiKey) {
      throw new V2Error("apiKey is required", { code: "invalid_api_key" });
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /**
   * Close a permit lifecycle by recording the outcome of the wrapped
   * callback. Mirrors `POST /v2/permits/:id/consume`. The raw payload
   * is never sent — only `payload_hash` (caller computes via
   * {@link hashPayload}).
   */
  async consume(input: ConsumeInput): Promise<ConsumeResponse> {
    const body: ConsumeRequest = {
      permit_id: input.permitId,
      payload_hash: input.payloadHash,
      execution_status: input.executionStatus,
      api_key: this.apiKey,
      ...(input.executionHash !== undefined
        ? { execution_hash: input.executionHash }
        : {}),
    };
    return this.post<ConsumeResponse>(
      `/v2/permits/${encodeURIComponent(input.permitId)}/consume`,
      body,
    );
  }

  /**
   * Batch evaluate. Mirrors `POST /v2/evaluate:batch` — one HTTP call
   * for N decisions, one rate-limit decrement, one hash-chain entry.
   * Order is preserved: `result.items[i]` decides `requests[i]`.
   *
   * Throws `V2Error` (code `invalid_argument`) when `requests` is
   * empty or exceeds 1000 — the wire-side contract bound.
   */
  async evaluateBatch(
    requests: BatchEvaluateItem[],
  ): Promise<EvaluateBatchResponse> {
    if (!Array.isArray(requests) || requests.length === 0) {
      throw new V2Error("requests must be a non-empty array", {
        code: "invalid_argument",
      });
    }
    if (requests.length > 1000) {
      throw new V2Error(
        `requests length ${requests.length} exceeds maximum of 1000`,
        { code: "invalid_argument" },
      );
    }
    const body: EvaluateBatchRequest = {
      requests,
      api_key: this.apiKey,
    };
    return this.post<EvaluateBatchResponse>("/v2/evaluate:batch", body);
  }

  /**
   * Server-side proof verification. Mirrors
   * `POST /v2/proofs/:id/verify`. Returns the canonical
   * {@link ProofVerificationResult} that the offline CLI also
   * produces — online and offline paths emit byte-identical output.
   */
  async verifyProof(proofId: string): Promise<ProofVerificationResult> {
    if (!proofId) {
      throw new V2Error("proofId is required", { code: "invalid_argument" });
    }
    return this.post<ProofVerificationResult>(
      `/v2/proofs/${encodeURIComponent(proofId)}/verify`,
      { api_key: this.apiKey },
    );
  }

  /**
   * Subscribe to the v2 decision-event stream (Pillar 3). Returns an
   * async iterable that yields one {@link DecisionEvent} per server
   * frame; iterate with `for await`.
   *
   * Reconnect: on disconnect, restart by passing the last seen
   * `event.id` as `lastEventId` and the server replays from there.
   *
   * Cancel: pass an `AbortSignal`; aborting closes the underlying
   * connection and ends the iterable.
   */
  async *subscribeDecisions(options?: {
    lastEventId?: string;
    signal?: AbortSignal;
  }): AsyncGenerator<DecisionEvent, void, undefined> {
    const url = `${this.baseUrl}/v2/decisions:subscribe`;
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      Authorization: `Bearer ${this.apiKey}`,
      "User-Agent": "atlasent-sdk-v2-alpha/2.0.0-alpha.0",
    };
    if (options?.lastEventId) {
      headers["Last-Event-ID"] = options.lastEventId;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers,
        ...(options?.signal ? { signal: options.signal } : {}),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      const message = err instanceof Error ? err.message : String(err);
      throw new V2Error(`Failed to connect to ${url}: ${message}`, {
        code: "network",
      });
    }

    if (!response.ok) {
      const code = response.status === 401 ? "invalid_api_key" : "http_error";
      throw new V2Error(
        response.status === 401
          ? "Invalid API key"
          : `API error ${response.status} on /v2/decisions:subscribe`,
        { status: response.status, code },
      );
    }

    if (!response.body) {
      throw new V2Error("Subscribe response has no body", {
        status: response.status,
        code: "bad_response",
      });
    }

    const stream = response.body as unknown as AsyncIterable<Uint8Array>;
    try {
      for await (const frame of parseSSE(stream)) {
        if (frame.data === "") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(frame.data);
        } catch {
          // Malformed JSON in a frame — skip it rather than tearing
          // down the whole stream. The wire contract is JSON-per-frame.
          continue;
        }
        if (parsed && typeof parsed === "object") {
          yield parsed as DecisionEvent;
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      throw err;
    }
  }

  private async post<TResponse>(path: string, body: unknown): Promise<TResponse> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "User-Agent": "atlasent-sdk-v2-alpha/2.0.0-alpha.0",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new V2Error(`Request to ${path} timed out after ${this.timeoutMs}ms`, {
          code: "timeout",
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new V2Error(`Failed to connect to ${url}: ${message}`, {
        code: "network",
      });
    } finally {
      clearTimeout(timeout);
    }

    let parsed: unknown;
    const text = await response.text();
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        if (response.ok) {
          throw new V2Error(`Malformed JSON in response from ${path}`, {
            status: response.status,
            code: "bad_response",
          });
        }
      }
    }

    if (!response.ok) {
      const code = response.status === 401 ? "invalid_api_key" : "http_error";
      const message =
        response.status === 401
          ? "Invalid API key"
          : `API error ${response.status} on ${path}`;
      throw new V2Error(message, {
        status: response.status,
        code,
        responseBody: parsed ?? text,
      });
    }

    return parsed as TResponse;
  }
}
