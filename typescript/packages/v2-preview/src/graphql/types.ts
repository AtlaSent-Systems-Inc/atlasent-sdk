/**
 * v2 Pillar — GraphQL client types.
 *
 * Wire shapes for GraphQL-over-HTTP per
 * https://graphql.org/learn/serving-over-http/. The v2 SDK exposes
 * a sub-path import (`@atlasent/sdk/graphql` at v2 GA) backed by
 * these types.
 *
 * Held in the v2-preview package while the GraphQL endpoint shape
 * stabilises in `atlasent-api`. PR #77's "hand-written vs.
 * generated from SDL" open question keeps these hand-written for
 * now; SDL codegen replaces or augments at v2 GA.
 */

/** GraphQL request body posted to the GraphQL endpoint. */
export interface GraphQLRequest {
  /** GraphQL query / mutation document. */
  query: string;
  /** Variables referenced in the query. */
  variables?: Record<string, unknown>;
  /** Operation name when the document defines multiple. */
  operationName?: string;
}

/**
 * One error in a GraphQL response. Per spec `message` is required;
 * everything else is informational.
 */
export interface GraphQLError {
  message: string;
  /** Path through the response data where the error occurred. */
  path?: ReadonlyArray<string | number>;
  /** Source positions in the query document. */
  locations?: ReadonlyArray<{ line: number; column: number }>;
  /** Server-defined error metadata — e.g. `{ code: "FORBIDDEN" }`. */
  extensions?: Record<string, unknown>;
}

/**
 * GraphQL response envelope. `data` and `errors` are independent —
 * a query can succeed partially with both populated. Spec-wise:
 *
 *   - `data: null` + `errors: [...]` → query completely failed
 *   - `data: {...}` + `errors: [...]` → partial success
 *   - `data: {...}` + no `errors`     → fully successful
 *
 * Generic on the data shape so callers carry their own type for
 * each query's response.
 */
export interface GraphQLResponse<TData = unknown> {
  data?: TData | null;
  errors?: ReadonlyArray<GraphQLError>;
  /** Server-defined extensions (timing, tracing, etc.). */
  extensions?: Record<string, unknown>;
}

/** Constructor options for {@link GraphQLClient}. */
export interface GraphQLClientOptions {
  /**
   * GraphQL endpoint URL. Open question (PR #77) — default endpoint
   * shape isn't locked yet; pass explicitly.
   */
  endpoint: string;
  /** AtlaSent API key. Sent as `Authorization: Bearer <key>`. */
  apiKey: string;
  /** Per-request timeout in milliseconds. Defaults to 10_000. */
  timeoutMs?: number;
  /**
   * Inject a fetch implementation (primarily for testing).
   * Defaults to `globalThis.fetch`.
   */
  fetch?: typeof fetch;
  /**
   * Extra HTTP headers added to every request. Authorization /
   * Content-Type / Accept are set by the client and cannot be
   * overridden via this map.
   */
  headers?: Record<string, string>;
}
