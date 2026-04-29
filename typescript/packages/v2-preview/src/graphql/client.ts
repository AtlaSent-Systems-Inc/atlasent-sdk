/**
 * GraphQL client for the v2 SDK preview.
 *
 * Pure GraphQL-over-HTTP — no schema introspection, no SDL codegen,
 * no caching layer. Hand-written per PR #77's default plan; SDL
 * codegen replaces or augments at v2 GA.
 *
 * Design notes:
 *
 *   - Native `fetch` + `AbortSignal.timeout`. Same plumbing v1's
 *     `AtlaSentClient` uses, no extra deps.
 *   - Authorization, Content-Type, Accept headers locked by the
 *     client; `headers` option layers on top for custom needs
 *     (correlation ids, tenant tags, etc.).
 *   - GraphQL errors (response 200 with `errors` populated) are
 *     returned to the caller in the result envelope, NOT thrown.
 *     Transport / HTTP / parse errors throw {@link GraphQLClientError}
 *     so callers can branch cleanly: `try/catch` for the
 *     fail-closed taxonomy, `result.errors` for partial-success
 *     shapes.
 */

import type {
  GraphQLClientOptions,
  GraphQLRequest,
  GraphQLResponse,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const SDK_VERSION = "2.0.0-preview.0";

/**
 * Error thrown for transport / HTTP / parse failures from
 * {@link GraphQLClient}. GraphQL-level errors (response 200 with
 * `errors` populated) are NOT thrown — they live in the response
 * envelope.
 */
export class GraphQLClientError extends Error {
  /** HTTP status code, when applicable. */
  readonly status?: number;
  /** Error category for branching. */
  readonly code:
    | "network"
    | "timeout"
    | "http_error"
    | "parse_error"
    | "invalid_response";

  constructor(
    message: string,
    init: {
      code: GraphQLClientError["code"];
      status?: number;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "GraphQLClientError";
    this.code = init.code;
    if (init.status !== undefined) this.status = init.status;
    if (init.cause !== undefined) {
      (this as { cause?: unknown }).cause = init.cause;
    }
  }
}

/**
 * Build a wire-shaped GraphQL request body. Exported for callers
 * who want to use their own HTTP transport while keeping the
 * envelope shape consistent.
 */
export function buildGraphQLRequest(
  query: string,
  variables?: Record<string, unknown>,
  operationName?: string,
): GraphQLRequest {
  if (typeof query !== "string" || query.length === 0) {
    throw new GraphQLClientError("query must be a non-empty string", {
      code: "invalid_response",
    });
  }
  const out: GraphQLRequest = { query };
  if (variables !== undefined) out.variables = variables;
  if (operationName !== undefined) out.operationName = operationName;
  return out;
}

/**
 * Hand-rolled GraphQL client. Single `query()` method dispatches
 * any document; callers carry their own response types via the
 * generic. No introspection, no caching, no batching — those layer
 * on top in customer code or at v2 GA.
 *
 * @example
 *   const gql = new GraphQLClient({
 *     endpoint: "https://api.atlasent.io/v2/graphql",
 *     apiKey: "ask_live_...",
 *   });
 *   const result = await gql.query<{ policies: Policy[] }>(
 *     `query Policies($filter: PolicyFilter) {
 *        policies(filter: $filter) { id name active }
 *      }`,
 *     { filter: { active: true } },
 *   );
 *   if (result.errors) handle(result.errors);
 *   else use(result.data?.policies);
 */
export class GraphQLClient {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly extraHeaders: Record<string, string>;

  constructor(options: GraphQLClientOptions) {
    if (!options.endpoint || typeof options.endpoint !== "string") {
      throw new GraphQLClientError("endpoint is required", {
        code: "invalid_response",
      });
    }
    if (!options.apiKey || typeof options.apiKey !== "string") {
      throw new GraphQLClientError("apiKey is required", {
        code: "invalid_response",
      });
    }
    this.endpoint = options.endpoint;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.extraHeaders = { ...(options.headers ?? {}) };
  }

  /**
   * Execute a GraphQL operation. Returns the response envelope as-is
   * — `data` and `errors` may both be present per the spec. Throws
   * {@link GraphQLClientError} on transport / HTTP / parse failures.
   */
  async query<TData = unknown>(
    query: string,
    variables?: Record<string, unknown>,
    operationName?: string,
  ): Promise<GraphQLResponse<TData>> {
    const body = buildGraphQLRequest(query, variables, operationName);

    const headers: Record<string, string> = {
      ...this.extraHeaders,
      // Locked headers — set last so they can't be overridden.
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      "User-Agent": `@atlasent/sdk-v2-preview/${SDK_VERSION} graphql node/${process.version}`,
      "X-Request-ID": globalThis.crypto.randomUUID(),
    };

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw mapTransportError(err);
    }

    if (!response.ok) {
      const text = await safeText(response);
      throw new GraphQLClientError(
        `GraphQL endpoint returned HTTP ${response.status}` +
          (text ? `: ${text.slice(0, 200)}` : ""),
        { code: "http_error", status: response.status },
      );
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (err) {
      throw new GraphQLClientError(
        "Invalid JSON in GraphQL response body",
        { code: "parse_error", status: response.status, cause: err },
      );
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new GraphQLClientError(
        "GraphQL response must be a JSON object",
        { code: "invalid_response", status: response.status },
      );
    }

    // The spec doesn't require `data` to be present (errors-only
    // responses are valid), so we don't validate further here.
    return parsed as GraphQLResponse<TData>;
  }
}

function mapTransportError(err: unknown): GraphQLClientError {
  if (err instanceof GraphQLClientError) return err;
  if (err instanceof DOMException && err.name === "TimeoutError") {
    return new GraphQLClientError("Request to GraphQL endpoint timed out", {
      code: "timeout",
      cause: err,
    });
  }
  if (err instanceof Error && err.name === "AbortError") {
    return new GraphQLClientError("Request to GraphQL endpoint timed out", {
      code: "timeout",
      cause: err,
    });
  }
  const message = err instanceof Error ? err.message : "network error";
  return new GraphQLClientError(`Failed to reach GraphQL endpoint: ${message}`, {
    code: "network",
    cause: err,
  });
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
