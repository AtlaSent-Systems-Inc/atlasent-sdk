/**
 * Hybrid trust-root bootstrap and snapshot management.
 *
 * At module load, seeds from the vendor snapshot in vendor/trust-root/.
 * Optionally refreshes from https://keys.atlasent.io/.well-known/ on
 * a configurable interval (default 4h, floor 5 min per ADR-005 D2).
 * Refresh failure is silent — falls back to the in-memory snapshot.
 *
 * Snapshot expiry (valid_until) is fail-closed per ADR-005 D3:
 * checkExpiry() emits a one-time console.warn at half-life, and again
 * on expiry. verifyAuditBundle throws BundleVerificationError when
 * expired (unless allowExpiredSnapshot=true is passed).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

// Types for the trust-root document shapes
export interface TrustRootKey {
  kid: string;
  role: "R1_release" | "R2_permit" | "R3_audit" | "R4_pack";
  kty: string;
  crv?: string;
  alg: string;
  x?: string;
  valid_from?: string | null;
  valid_until?: string | null;
  replaced_by?: string | null;
  revoked?: boolean;
  tenant?: string | null;
}

export interface TrustRootRevocationEntry {
  kid: string;
  role?: string;
  revoked_at: string;
  reason?: string;
}

export interface TrustRootSnapshot {
  /** ISO-8601 expiry of this snapshot; fail-closed when exceeded */
  valid_until: string;
  issued_at: string;
  keys: TrustRootKey[];
  revoked_keys: TrustRootRevocationEntry[];
  revoked_identities: Array<{ identity: string; revoked_at: string; reason?: string }>;
}

export interface TrustRootManagerOptions {
  /** Override the refresh URL (default: https://keys.atlasent.io/.well-known/) */
  refreshBaseUrl?: string;
  /** Refresh interval in ms. Default: 4h. Floor: 5 min. */
  refreshIntervalMs?: number;
  /** Disable automatic background refresh. */
  disableRefresh?: boolean;
  /** Custom fetch implementation (for tests). */
  fetch?: typeof fetch;
}

const REFRESH_INTERVAL_MS_DEFAULT = 4 * 60 * 60 * 1000; // 4 hours
const REFRESH_INTERVAL_MS_FLOOR = 5 * 60 * 1000; // 5 minutes
const KEYS_BASE_URL = "https://keys.atlasent.io/.well-known";

// Half-life and expiry warnings: emitted once per process (ADR-005 D3).
let _halfLifeWarningEmitted = false;
let _expiredWarningEmitted = false;

function _resetWarningFlags(): void {
  _halfLifeWarningEmitted = false;
  _expiredWarningEmitted = false;
}

export class TrustRootManager {
  private _snapshot: TrustRootSnapshot;
  private _refreshTimer: ReturnType<typeof setInterval> | null = null;
  private readonly _opts: Required<TrustRootManagerOptions>;

  constructor(
    initialSnapshot: TrustRootSnapshot,
    opts: TrustRootManagerOptions = {},
  ) {
    this._snapshot = initialSnapshot;
    const intervalMs = Math.max(
      opts.refreshIntervalMs ?? REFRESH_INTERVAL_MS_DEFAULT,
      REFRESH_INTERVAL_MS_FLOOR,
    );
    this._opts = {
      refreshBaseUrl: opts.refreshBaseUrl ?? KEYS_BASE_URL,
      refreshIntervalMs: intervalMs,
      disableRefresh: opts.disableRefresh ?? false,
      fetch:
        opts.fetch ??
        (typeof globalThis !== "undefined" && globalThis.fetch
          ? globalThis.fetch.bind(globalThis)
          : ((_url: string) =>
              Promise.reject(new Error("fetch not available"))) as typeof fetch),
    };
    if (!this._opts.disableRefresh) {
      this._scheduleRefresh();
    }
  }

  getSnapshot(): TrustRootSnapshot {
    return this._snapshot;
  }

  /**
   * Check whether the snapshot is expired, emit one-time warnings at
   * half-life and expiry.  Returns "ok" | "half_life" | "expired".
   *
   * Emits console.warn once per process at half-life (ADR-005 D3).
   * Emits console.warn once per process on expiry.
   */
  checkExpiry(): "ok" | "half_life" | "expired" {
    const snap = this._snapshot;
    const now = Date.now();
    const issuedAt = new Date(snap.issued_at).getTime();
    const validUntil = new Date(snap.valid_until).getTime();

    if (now > validUntil) {
      if (!_expiredWarningEmitted) {
        _expiredWarningEmitted = true;
        const daysAgo = Math.floor((now - validUntil) / (24 * 60 * 60 * 1000));
        // eslint-disable-next-line no-console
        console.warn(
          `[atlasent] Trust snapshot expired ${daysAgo} day(s) ago (valid_until: ${snap.valid_until}). ` +
            "Update to a newer SDK build or enable allowExpiredSnapshot.",
        );
      }
      return "expired";
    }
    const window = validUntil - issuedAt;
    const halfLife = issuedAt + window / 2;
    if (now > halfLife) {
      if (!_halfLifeWarningEmitted) {
        _halfLifeWarningEmitted = true;
        const daysLeft = Math.floor((validUntil - now) / (24 * 60 * 60 * 1000));
        // eslint-disable-next-line no-console
        console.warn(
          `[atlasent] Trust snapshot expires in ${daysLeft} day(s) — past half-life (valid_until: ${snap.valid_until}). ` +
            "Plan an SDK update.",
        );
      }
      return "half_life";
    }
    return "ok";
  }

  /** Look up a key entry by kid. Returns undefined if not found. */
  lookupKey(kid: string): TrustRootKey | undefined {
    return this._snapshot.keys.find((k) => k.kid === kid);
  }

  /** Returns true if the kid appears in revoked_keys. */
  isRevoked(kid: string): boolean {
    return this._snapshot.revoked_keys.some((r) => r.kid === kid);
  }

  /** Replace the snapshot (e.g. after a successful refresh). */
  replaceSnapshot(next: TrustRootSnapshot): void {
    this._snapshot = next;
  }

  stopRefresh(): void {
    if (this._refreshTimer !== null) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  private _scheduleRefresh(): void {
    this._refreshTimer = setInterval(() => {
      void this._doRefresh();
    }, this._opts.refreshIntervalMs);
    // Don't hold the process open.
    if (
      this._refreshTimer &&
      typeof this._refreshTimer === "object" &&
      "unref" in this._refreshTimer
    ) {
      (this._refreshTimer as { unref(): void }).unref();
    }
  }

  private async _doRefresh(): Promise<void> {
    try {
      const base = this._opts.refreshBaseUrl.replace(/\/$/, "");
      const [keysRes, revocRes] = await Promise.all([
        this._opts.fetch(`${base}/atlasent-verifier-keys.json`),
        this._opts.fetch(`${base}/atlasent-revocations.json`),
      ]);
      const indexRes = await this._opts.fetch(`${base}/atlasent-trust-root.json`);

      if (!keysRes.ok || !revocRes.ok || !indexRes.ok) return;

      const [keys, revoc, index] = await Promise.all([
        keysRes.json() as Promise<{ keys: TrustRootKey[] }>,
        revocRes.json() as Promise<{
          revoked_keys: TrustRootRevocationEntry[];
          revoked_identities: unknown[];
        }>,
        indexRes.json() as Promise<{ valid_until: string; issued_at: string }>,
      ]);

      if (!index.valid_until || !Array.isArray(keys.keys)) return;

      this._snapshot = {
        valid_until: index.valid_until,
        issued_at: index.issued_at ?? this._snapshot.issued_at,
        keys: keys.keys,
        revoked_keys: revoc.revoked_keys ?? [],
        revoked_identities:
          (revoc.revoked_identities as Array<{
            identity: string;
            revoked_at: string;
          }>) ?? [],
      };
    } catch {
      // Refresh failure is silent — keep using the current snapshot.
    }
  }
}

// ─── Load the embedded (vendor) snapshot ─────────────────────────────────────

function _loadVendorSnapshot(): TrustRootSnapshot {
  try {
    // Resolve relative to the package root. Works both when running from
    // typescript/ (dev) and from dist/ (published).
    let packageRoot: string;
    try {
      // ESM: use import.meta.url
      const thisFile = fileURLToPath(import.meta.url);
      // src/trustRoot.ts → ../../vendor/trust-root  OR
      // dist/trustRoot.js → ../../vendor/trust-root
      packageRoot = resolve(dirname(thisFile), "..", "..");
    } catch {
      // CJS or bundler: fall back to __dirname if available
      packageRoot = resolve(__dirname, "..", "..");
    }

    const vendorDir = resolve(packageRoot, "vendor", "trust-root");

    const index = JSON.parse(
      readFileSync(resolve(vendorDir, "atlasent-trust-root.json"), "utf8"),
    ) as { valid_until: string; issued_at: string };

    const verifierKeys = JSON.parse(
      readFileSync(resolve(vendorDir, "atlasent-verifier-keys.json"), "utf8"),
    ) as { keys: TrustRootKey[] };

    const revocations = JSON.parse(
      readFileSync(resolve(vendorDir, "atlasent-revocations.json"), "utf8"),
    ) as {
      revoked_keys: TrustRootRevocationEntry[];
      revoked_identities: Array<{ identity: string; revoked_at: string }>;
    };

    return {
      valid_until: index.valid_until,
      issued_at: index.issued_at,
      keys: verifierKeys.keys ?? [],
      revoked_keys: revocations.revoked_keys ?? [],
      revoked_identities: revocations.revoked_identities ?? [],
    };
  } catch {
    // Fallback: a minimal never-expiring snapshot so the SDK degrades
    // gracefully in build environments where vendor/ is not present.
    return {
      valid_until: "2099-01-01T00:00:00Z",
      issued_at: "2026-05-26T00:00:00Z",
      keys: [],
      revoked_keys: [],
      revoked_identities: [],
    };
  }
}

// Process-global manager — created lazily.
let _globalManager: TrustRootManager | null = null;

export function getGlobalTrustRootManager(
  opts?: TrustRootManagerOptions,
): TrustRootManager {
  if (!_globalManager) {
    _globalManager = new TrustRootManager(
      _loadVendorSnapshot(),
      opts ?? { disableRefresh: false },
    );
  }
  return _globalManager;
}

/** Replace the global manager (primarily for tests). */
export function __setGlobalTrustRootManagerForTests(
  mgr: TrustRootManager | null,
): void {
  _globalManager = mgr;
  _resetWarningFlags();
}

export { _resetWarningFlags as __resetWarningFlagsForTests };
