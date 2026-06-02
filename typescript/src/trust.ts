/**
 * Trust-root Phase 2 — hybrid snapshot bootstrap + revocation enforcement.
 *
 * Provides a lightweight TrustSnapshot type (numeric epoch timestamps,
 * JWK-array keys, flat revoked_kids list) alongside three helpers that
 * the verify() path and application code can call directly.
 *
 * Design decisions (ADR-005):
 *
 * - D3 (fail-closed expiry): isTrustSnapshotExpired() defaults to a 24-hour
 *   TTL and returns true when the snapshot is older than that or when
 *   expires_at has already passed. Callers in verify() must treat an expired
 *   snapshot as a denial.
 *
 * - D4 (R2/R3 split): revoked_kids is a flat allowlist consulted for ANY
 *   KID regardless of role. Role enforcement belongs in auditBundle.ts;
 *   this module only answers "is this KID revoked?"
 *
 * - Bootstrap: bootstrapTrust() fetches the .well-known endpoint and merges
 *   the response with an optional pinned snapshot.  The pinned snapshot is
 *   returned as-is if the fetch fails (silent fallback).
 *
 * - Refresh: background scheduling is handled by TrustRootManager in
 *   trustRoot.ts.  bootstrapTrust() is intentionally a one-shot function
 *   for callers that need an explicit initial snapshot without wiring up
 *   the full manager.
 */

/**
 * Minimal JWK key entry as returned by the .well-known endpoint.
 *
 * Deliberately loose — additional vendor-defined fields (kid, use,
 * alg, crv, x, …) are preserved but not enumerated here so the type
 * survives forward additions to the key document.
 */
export interface JWK {
  /** Key identifier — used for revocation checks. */
  kid: string;
  /** Key type, e.g. "OKP", "EC", "RSA". */
  kty: string;
  [key: string]: unknown;
}

/**
 * Trust snapshot in the Phase 2 wire format.
 *
 * Uses numeric epoch-millisecond timestamps so callers can compare
 * directly with Date.now() without parsing ISO-8601 strings.
 */
export interface TrustSnapshot {
  /** Active verification keys from the trust root. */
  keys: JWK[];
  /** KIDs that have been revoked; any permit signed by these must be rejected. */
  revoked_kids: string[];
  /**
   * Unix epoch (ms) when this snapshot was fetched from the server.
   * Used as the reference point for TTL expiry checks.
   */
  fetched_at: number;
  /**
   * Unix epoch (ms) at which this snapshot expires regardless of TTL.
   * bootstrapTrust() derives this from the `valid_until` field in the
   * server response when available, otherwise from fetched_at + TTL.
   */
  expires_at: number;
}

/** Default snapshot TTL: 24 hours in milliseconds. */
export const DEFAULT_TRUST_TTL_MS = 24 * 60 * 60 * 1000;

/** Wire shape returned by ${baseUrl}/.well-known/atlasent-keys.json */
interface TrustKeysWire {
  keys?: unknown[];
  revoked_kids?: string[];
  revoked_keys?: Array<{ kid: string; [k: string]: unknown }>;
  valid_until?: string;
  issued_at?: string;
}

/**
 * Fetch a fresh TrustSnapshot from the AtlaSent keys endpoint.
 *
 * Calls `${baseUrl}/.well-known/atlasent-keys.json` with a 10-second
 * timeout.  On any failure (network error, non-2xx, malformed response)
 * the function returns the `pinnedSnapshot` if provided, or re-throws
 * the underlying error when no fallback is available.
 *
 * The `expires_at` field is derived from the server's `valid_until` field
 * when present; otherwise it is set to `fetched_at + ttlMs`.
 *
 * @param baseUrl       Root URL of the AtlaSent API (no trailing slash).
 * @param pinnedSnapshot Optional pre-loaded snapshot to use as fallback.
 * @param ttlMs         TTL for the snapshot in ms (default: 24 hours).
 * @param fetchImpl     Custom fetch implementation (for tests/environments
 *                      without a global fetch).
 */
export async function bootstrapTrust(
  baseUrl: string,
  pinnedSnapshot?: TrustSnapshot,
  ttlMs: number = DEFAULT_TRUST_TTL_MS,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<TrustSnapshot> {
  const url = `${baseUrl.replace(/\/+$/, "")}/.well-known/atlasent-keys.json`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    let response: Response;
    try {
      response = await fetchImpl(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      if (pinnedSnapshot !== undefined) return pinnedSnapshot;
      throw new Error(
        `bootstrapTrust: server returned HTTP ${response.status} from ${url}`,
      );
    }

    const wire = (await response.json()) as TrustKeysWire;

    // Coerce keys to JWK[]: accept any array entry that has a `kid` string.
    const rawKeys: unknown[] = Array.isArray(wire.keys) ? wire.keys : [];
    const keys: JWK[] = rawKeys.filter(
      (k): k is JWK =>
        k !== null &&
        typeof k === "object" &&
        typeof (k as Record<string, unknown>).kid === "string" &&
        typeof (k as Record<string, unknown>).kty === "string",
    ) as JWK[];

    // Revoked KIDs: may come as a flat `revoked_kids` array or as the
    // TrustRootSnapshot-style `revoked_keys` array of objects.
    const revokedKids: string[] = Array.isArray(wire.revoked_kids)
      ? wire.revoked_kids.filter((k): k is string => typeof k === "string")
      : Array.isArray(wire.revoked_keys)
        ? wire.revoked_keys
            .filter(
              (r): r is { kid: string } =>
                r !== null &&
                typeof r === "object" &&
                typeof (r as Record<string, unknown>).kid === "string",
            )
            .map((r) => r.kid)
        : [];

    const fetchedAt = Date.now();
    const expiresAt =
      typeof wire.valid_until === "string" && wire.valid_until.length > 0
        ? new Date(wire.valid_until).getTime()
        : fetchedAt + ttlMs;

    return {
      keys,
      revoked_kids: revokedKids,
      fetched_at: fetchedAt,
      expires_at: Number.isFinite(expiresAt) ? expiresAt : fetchedAt + ttlMs,
    };
  } catch (err) {
    if (pinnedSnapshot !== undefined) {
      // Silent fallback to the pinned snapshot (ADR-005 D2 refresh-failure policy).
      return pinnedSnapshot;
    }
    throw err;
  }
}

/**
 * Returns true when the snapshot should be treated as expired.
 *
 * A snapshot is expired when EITHER:
 *   1. `expires_at` is in the past, OR
 *   2. `fetched_at + ttlMs` is in the past (age-based eviction).
 *
 * The stricter of the two checks wins so a snapshot that was fetched
 * recently but carries an already-expired `expires_at` is still rejected.
 *
 * ADR-005 D3: callers in the verify() path MUST treat an expired
 * snapshot as a denial (`failClosedOnExpiry` is honoured by the client
 * integration — see verify.ts).
 *
 * @param snapshot  The snapshot to check.
 * @param ttlMs     Maximum age in ms from `fetched_at` (default: 24 hours).
 * @param nowMs     Override for `Date.now()` (for testing).
 */
export function isTrustSnapshotExpired(
  snapshot: TrustSnapshot,
  ttlMs: number = DEFAULT_TRUST_TTL_MS,
  nowMs: number = Date.now(),
): boolean {
  // Check explicit expiry timestamp
  if (nowMs > snapshot.expires_at) return true;
  // Check age-based TTL from when the snapshot was fetched
  if (nowMs > snapshot.fetched_at + ttlMs) return true;
  return false;
}

/**
 * Returns true when the given KID appears in the snapshot's revocation list.
 *
 * Used by the verify() path before accepting a permit's signature:
 * ```ts
 * if (isKidRevoked(snapshot, permit.kid)) {
 *   return { valid: false, reason: 'SIGNING_KEY_REVOKED' };
 * }
 * ```
 *
 * @param snapshot  Trust snapshot to consult.
 * @param kid       Key identifier from the permit or audit bundle header.
 */
export function isKidRevoked(snapshot: TrustSnapshot, kid: string): boolean {
  return snapshot.revoked_kids.includes(kid);
}
