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
  ConsumeRequest,
  ConsumeResponse,
  ProofVerificationResult,
} from "./types.js";

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
