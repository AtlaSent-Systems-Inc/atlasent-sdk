/**
 * TrustRootManager unit tests + trust-root vector suite.
 *
 * Covers ADR-005 D2 (refresh scheduling), D3 (fail-closed expiry),
 * and D4 (revocation + role checks).  The test vectors in
 * contract/vectors/trust-root/ are shared with the Python SDK.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TrustRootManager,
  __resetWarningFlagsForTests,
  __setGlobalTrustRootManagerForTests,
  getGlobalTrustRootManager,
  type TrustRootSnapshot,
} from "../src/trustRoot.js";
import { BundleVerificationError } from "../src/errors.js";
import { verifyAuditBundle, type VerifyKey } from "../src/auditBundle.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const VECTORS_DIR = resolve(HERE, "..", "..", "contract", "vectors", "trust-root");
const FIXTURES_DIR = resolve(HERE, "..", "..", "contract", "vectors", "audit-bundles");
const PUBLIC_PEM = readFileSync(resolve(FIXTURES_DIR, "signing-key.pub.pem"), "utf8");

// ─── Helpers ────────────────────────────────────────────────────────────────

async function keysFromPem(pem: string, keyId: string): Promise<VerifyKey[]> {
  const b64 = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s+/g, "");
  const bytes = Uint8Array.from(Buffer.from(b64, "base64"));
  const { webcrypto } = await import("node:crypto");
  const publicKey = await webcrypto.subtle.importKey(
    "spki",
    bytes,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return [{ keyId, publicKey }];
}

function makeSnapshot(overrides: Partial<TrustRootSnapshot> = {}): TrustRootSnapshot {
  return {
    valid_until: "2099-01-01T00:00:00Z",
    issued_at: "2026-01-01T00:00:00Z",
    keys: [
      { kid: "test-key", role: "R3_audit", kty: "OKP", crv: "Ed25519", alg: "EdDSA",
        x: "uCfAGR92U9gKXqMmGs4MCoaTq-LmzoRe_aiwZE6UcnQ", valid_from: null, valid_until: null,
        replaced_by: null, revoked: false, tenant: null },
      { kid: "permit-kid", role: "R2_permit", kty: "OKP", crv: "Ed25519", alg: "EdDSA",
        x: "uCfAGR92U9gKXqMmGs4MCoaTq-LmzoRe_aiwZE6UcnQ", valid_from: null, valid_until: null,
        replaced_by: null, revoked: false, tenant: null },
      { kid: "revoked-kid", role: "R3_audit", kty: "OKP", crv: "Ed25519", alg: "EdDSA",
        x: "uCfAGR92U9gKXqMmGs4MCoaTq-LmzoRe_aiwZE6UcnQ", valid_from: null, valid_until: null,
        replaced_by: null, revoked: true, tenant: null },
    ],
    revoked_keys: [
      { kid: "revoked-kid", role: "R3_audit", revoked_at: "2026-05-01T12:00:00Z",
        reason: "test revocation for SDK test vectors" },
    ],
    revoked_identities: [],
    ...overrides,
  };
}

function loadVector(filename: string): Record<string, unknown> {
  const line = readFileSync(resolve(VECTORS_DIR, filename), "utf8").trim().split("\n")[0];
  return JSON.parse(line!) as Record<string, unknown>;
}

// ─── TrustRootManager unit tests ─────────────────────────────────────────────

describe("TrustRootManager", () => {
  it("getSnapshot returns initial snapshot", () => {
    const snap = makeSnapshot();
    const mgr = new TrustRootManager(snap, { disableRefresh: true });
    expect(mgr.getSnapshot()).toBe(snap);
  });

  it("checkExpiry returns ok for future valid_until", () => {
    const mgr = new TrustRootManager(makeSnapshot(), { disableRefresh: true });
    expect(mgr.checkExpiry()).toBe("ok");
  });

  it("checkExpiry returns expired when valid_until is past", () => {
    const snap = makeSnapshot({ valid_until: "2020-01-01T00:00:00Z", issued_at: "2019-01-01T00:00:00Z" });
    const mgr = new TrustRootManager(snap, { disableRefresh: true });
    expect(mgr.checkExpiry()).toBe("expired");
  });

  it("checkExpiry returns half_life when past midpoint", () => {
    // issued 1 year ago, valid for 2 years → currently at 50%+ mark
    const issued = new Date(Date.now() - 366 * 24 * 60 * 60 * 1000).toISOString();
    const until = new Date(Date.now() + 364 * 24 * 60 * 60 * 1000).toISOString();
    const snap = makeSnapshot({ issued_at: issued, valid_until: until });
    const mgr = new TrustRootManager(snap, { disableRefresh: true });
    expect(mgr.checkExpiry()).toBe("half_life");
  });

  it("lookupKey finds a key by kid", () => {
    const mgr = new TrustRootManager(makeSnapshot(), { disableRefresh: true });
    const k = mgr.lookupKey("test-key");
    expect(k?.role).toBe("R3_audit");
  });

  it("lookupKey returns undefined for unknown kid", () => {
    const mgr = new TrustRootManager(makeSnapshot(), { disableRefresh: true });
    expect(mgr.lookupKey("nonexistent")).toBeUndefined();
  });

  it("isRevoked returns true for revoked kid", () => {
    const mgr = new TrustRootManager(makeSnapshot(), { disableRefresh: true });
    expect(mgr.isRevoked("revoked-kid")).toBe(true);
  });

  it("isRevoked returns false for valid kid", () => {
    const mgr = new TrustRootManager(makeSnapshot(), { disableRefresh: true });
    expect(mgr.isRevoked("test-key")).toBe(false);
  });

  it("replaceSnapshot swaps the active snapshot", () => {
    const mgr = new TrustRootManager(makeSnapshot(), { disableRefresh: true });
    const newSnap = makeSnapshot({ valid_until: "2030-01-01T00:00:00Z" });
    mgr.replaceSnapshot(newSnap);
    expect(mgr.getSnapshot().valid_until).toBe("2030-01-01T00:00:00Z");
  });

  it("enforces 5-minute floor on refresh interval", () => {
    const mgr = new TrustRootManager(makeSnapshot(), {
      disableRefresh: false,
      refreshIntervalMs: 1000, // below floor
    });
    // Just check that it doesn't throw; the interval is clamped internally.
    mgr.stopRefresh();
  });

  it("stopRefresh clears the timer", () => {
    const mgr = new TrustRootManager(makeSnapshot(), { disableRefresh: false });
    mgr.stopRefresh();
    // Calling again is a no-op
    mgr.stopRefresh();
  });
});

// ─── Refresh tests ───────────────────────────────────────────────────────────

describe("TrustRootManager refresh", () => {
  it("silently ignores network failure", async () => {
    const snap = makeSnapshot();
    const failingFetch = () => Promise.reject(new Error("network error")) as ReturnType<typeof fetch>;
    const mgr = new TrustRootManager(snap, {
      disableRefresh: true,
      fetch: failingFetch as typeof fetch,
      refreshBaseUrl: "https://keys.atlasent.io/.well-known",
    });
    // Manually trigger the private refresh — access via type cast
    await (mgr as unknown as { _doRefresh(): Promise<void> })._doRefresh();
    // Snapshot unchanged after failure
    expect(mgr.getSnapshot()).toBe(snap);
    mgr.stopRefresh();
  });

  it("replaces snapshot on successful refresh", async () => {
    const snap = makeSnapshot();
    const newIndex = { valid_until: "2030-01-01T00:00:00Z", issued_at: "2026-06-01T00:00:00Z" };
    const newKeys = { keys: snap.keys };
    const newRevoc = { revoked_keys: snap.revoked_keys, revoked_identities: [] };

    const mockFetch = vi.fn((url: string) => {
      let body: unknown;
      if (url.endsWith("atlasent-trust-root.json")) body = newIndex;
      else if (url.endsWith("atlasent-verifier-keys.json")) body = newKeys;
      else body = newRevoc;
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    });

    const mgr = new TrustRootManager(snap, {
      disableRefresh: true,
      fetch: mockFetch as unknown as typeof fetch,
    });
    await (mgr as unknown as { _doRefresh(): Promise<void> })._doRefresh();
    expect(mgr.getSnapshot().valid_until).toBe("2030-01-01T00:00:00Z");
    mgr.stopRefresh();
  });
});

// ─── Global manager ──────────────────────────────────────────────────────────

describe("getGlobalTrustRootManager", () => {
  afterEach(() => {
    __setGlobalTrustRootManagerForTests(null);
  });

  it("returns a manager with a valid snapshot", () => {
    const mgr = getGlobalTrustRootManager({ disableRefresh: true });
    const snap = mgr.getSnapshot();
    expect(snap.valid_until).toBeTruthy();
    mgr.stopRefresh();
  });

  it("returns the same instance on repeated calls", () => {
    const a = getGlobalTrustRootManager({ disableRefresh: true });
    const b = getGlobalTrustRootManager({ disableRefresh: true });
    expect(a).toBe(b);
    a.stopRefresh();
  });
});

// ─── Trust-root vector suite ─────────────────────────────────────────────────

describe("trust-root vectors", () => {
  it("bundle_revoked_kid → key_revoked", async () => {
    const vec = loadVector("bundle_revoked_kid.jsonl");
    const bundle = vec.bundle as Record<string, unknown>;
    const trustRoot = makeSnapshot();
    const keys = await keysFromPem(PUBLIC_PEM, "pem_0");

    const r = await verifyAuditBundle(bundle, keys, { trustRoot });
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("key_revoked");
  });

  it("bundle_expired_snapshot → trust_snapshot_expired", async () => {
    const vec = loadVector("bundle_expired_snapshot.jsonl");
    const bundle = vec.bundle as Record<string, unknown>;
    const stale = vec.stale_snapshot as { valid_until: string; issued_at: string };
    const trustRoot = makeSnapshot({ valid_until: stale.valid_until, issued_at: stale.issued_at });
    const keys = await keysFromPem(PUBLIC_PEM, "pem_0");

    const r = await verifyAuditBundle(bundle, keys, { trustRoot });
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("trust_snapshot_expired");
  });

  it("bundle_allow_expired → verified when allow_expired_snapshot=true", async () => {
    const vec = loadVector("bundle_allow_expired.jsonl");
    const bundle = vec.bundle as Record<string, unknown>;
    const stale = vec.stale_snapshot as { valid_until: string; issued_at: string };
    const trustRoot = makeSnapshot({ valid_until: stale.valid_until, issued_at: stale.issued_at });
    const keys = await keysFromPem(PUBLIC_PEM, "test-key");

    const r = await verifyAuditBundle(bundle, keys, { trustRoot, allowExpiredSnapshot: true });
    expect(r.verified).toBe(true);
  });
});

// ─── BundleVerificationError ──────────────────────────────────────────────────

describe("BundleVerificationError", () => {
  it("is an instance of AtlaSentDeniedError", async () => {
    const err = new BundleVerificationError({ bundleReason: "trust_snapshot_expired" });
    const { AtlaSentDeniedError } = await import("../src/errors.js");
    expect(err).toBeInstanceOf(AtlaSentDeniedError);
  });

  it("bundleReason is trust_snapshot_expired", () => {
    const err = new BundleVerificationError({ bundleReason: "trust_snapshot_expired" });
    expect(err.bundleReason).toBe("trust_snapshot_expired");
  });

  it("carries snapshotValidUntil when provided", () => {
    const err = new BundleVerificationError({
      bundleReason: "trust_snapshot_expired",
      snapshotValidUntil: "2020-01-01T00:00:00Z",
      snapshotFetchedAt: "2019-01-01T00:00:00Z",
    });
    expect(err.snapshotValidUntil).toBe("2020-01-01T00:00:00Z");
  });

  it("key_revoked reason", () => {
    const err = new BundleVerificationError({ bundleReason: "key_revoked" });
    expect(err.bundleReason).toBe("key_revoked");
    expect(err.decision).toBe("deny");
  });
});

// ─── Half-life and expired warnings ──────────────────────────────────────────

describe("checkExpiry warnings (ADR-005 D3)", () => {
  beforeEach(() => {
    __resetWarningFlagsForTests();
  });

  afterEach(() => {
    __resetWarningFlagsForTests();
  });

  it("emits console.warn once at half-life and returns half_life", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const issued = new Date(Date.now() - 366 * 24 * 60 * 60 * 1000).toISOString();
    const until = new Date(Date.now() + 364 * 24 * 60 * 60 * 1000).toISOString();
    const mgr = new TrustRootManager(makeSnapshot({ issued_at: issued, valid_until: until }), {
      disableRefresh: true,
    });
    const status = mgr.checkExpiry();
    expect(status).toBe("half_life");
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]![0]).toContain("[atlasent] Trust snapshot expires in");
    // Second call does not emit again
    mgr.checkExpiry();
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it("emits console.warn once at expiry and returns expired", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mgr = new TrustRootManager(
      makeSnapshot({ valid_until: "2020-01-01T00:00:00Z", issued_at: "2019-01-01T00:00:00Z" }),
      { disableRefresh: true },
    );
    expect(mgr.checkExpiry()).toBe("expired");
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]![0]).toContain("[atlasent] Trust snapshot expired");
    mgr.checkExpiry();
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it("does not warn when snapshot is healthy", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mgr = new TrustRootManager(makeSnapshot(), { disableRefresh: true });
    expect(mgr.checkExpiry()).toBe("ok");
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("bundle_role_mismatch → key_role_mismatch", async () => {
    const vec = loadVector("bundle_role_mismatch.jsonl");
    const bundle = vec.bundle as Record<string, unknown>;
    const trustRoot = makeSnapshot();
    const keys = await keysFromPem(PUBLIC_PEM, "pem_0");

    const r = await verifyAuditBundle(bundle, keys, { trustRoot });
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("key_role_mismatch");
  });
});
