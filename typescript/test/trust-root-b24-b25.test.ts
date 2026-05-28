/**
 * B2.4 + B2.5 targeted tests.
 *
 * Covers: BundleVerificationError (throw, not return), permit_signing_key_revoked
 * outcome, half-life / expiry console.warn once-per-process (ADR-005 D3),
 * and global trust-root auto-inject into verifyBundle (B2.3 wire-in).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AtlaSentDeniedError,
  AtlaSentError,
  BundleVerificationError,
  normalizePermitOutcome,
} from "../src/errors.js";
import {
  TrustRootManager,
  __resetWarningFlagsForTests,
  __setGlobalTrustRootManagerForTests,
  getGlobalTrustRootManager,
  type TrustRootSnapshot,
} from "../src/trustRoot.js";
import { verifyAuditBundle, verifyBundle } from "../src/auditBundle.js";

// ─── Helpers ───────────────────────────────────────────────────────────────────────

function makeSnap(overrides: Partial<TrustRootSnapshot> = {}): TrustRootSnapshot {
  return {
    valid_until: "2099-01-01T00:00:00Z",
    issued_at: "2026-01-01T00:00:00Z",
    keys: [],
    revoked_keys: [],
    revoked_identities: [],
    ...overrides,
  };
}

function expiredSnap(): TrustRootSnapshot {
  return makeSnap({
    valid_until: "2020-01-01T00:00:00Z",
    issued_at: "2019-01-01T00:00:00Z",
  });
}

function halfLifeSnap(): TrustRootSnapshot {
  // issued 7 hours ago, valid for 8 hours total → currently past the half-life mark
  const now = Date.now();
  return makeSnap({
    issued_at: new Date(now - 7 * 60 * 60 * 1000).toISOString(),
    valid_until: new Date(now + 1 * 60 * 60 * 1000).toISOString(),
  });
}

const EMPTY_BUNDLE = {
  export_id: "test",
  org_id: "org-1",
  chain_head_hash: "0".repeat(64),
  event_count: 0,
  signed_at: "2026-01-01T00:00:00Z",
  events: [],
};

// ─── BundleVerificationError class ────────────────────────────────────────────────────

describe("BundleVerificationError", () => {
  it("name is BundleVerificationError", () => {
    expect(new BundleVerificationError({ bundleReason: "trust_snapshot_expired" }).name).toBe(
      "BundleVerificationError",
    );
  });

  it("message includes reason", () => {
    const err = new BundleVerificationError({ bundleReason: "key_revoked" });
    expect(err.message).toContain("key_revoked");
  });

  it("carries all init fields", () => {
    const err = new BundleVerificationError({
      bundleReason: "key_revoked",
      snapshotValidUntil: "2020-01-01T00:00:00Z",
      snapshotFetchedAt: "2019-01-01T00:00:00Z",
      snapshotSource: "pinned",
      kid: "kid-abc",
    });
    expect(err.bundleReason).toBe("key_revoked");
    expect(err.snapshotValidUntil).toBe("2020-01-01T00:00:00Z");
    expect(err.snapshotFetchedAt).toBe("2019-01-01T00:00:00Z");
    expect(err.snapshotSource).toBe("pinned");
    expect(err.kid).toBe("kid-abc");
  });

  it("is instanceof Error, AtlaSentError, and BundleVerificationError", () => {
    const err = new BundleVerificationError({ bundleReason: "key_role_mismatch" });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AtlaSentError);
    expect(err).toBeInstanceOf(BundleVerificationError);
  });
});

// ─── permit_signing_key_revoked ───────────────────────────────────────────────────────

describe("permit_signing_key_revoked outcome", () => {
  it("normalizePermitOutcome recognises the new literal", () => {
    expect(normalizePermitOutcome("permit_signing_key_revoked")).toBe(
      "permit_signing_key_revoked",
    );
  });

  it("normalizePermitOutcome returns undefined for unknown strings", () => {
    expect(normalizePermitOutcome("unknown_outcome")).toBeUndefined();
    expect(normalizePermitOutcome(undefined)).toBeUndefined();
    expect(normalizePermitOutcome("")).toBeUndefined();
  });

  it("AtlaSentDeniedError.isSigningKeyRevoked is true when outcome matches", () => {
    const err = new AtlaSentDeniedError({
      decision: "deny",
      evaluationId: "eval-1",
      outcome: "permit_signing_key_revoked",
    });
    expect(err.isSigningKeyRevoked).toBe(true);
    expect(err.isRevoked).toBe(false);
    expect(err.isExpired).toBe(false);
    expect(err.isConsumed).toBe(false);
  });

  it("AtlaSentDeniedError.isSigningKeyRevoked is false for other outcomes", () => {
    expect(
      new AtlaSentDeniedError({ decision: "deny", evaluationId: "e", outcome: "permit_revoked" })
        .isSigningKeyRevoked,
    ).toBe(false);
    expect(
      new AtlaSentDeniedError({ decision: "deny", evaluationId: "e" }).isSigningKeyRevoked,
    ).toBe(false);
  });
});

// ─── checkExpiry console.warn (once per process, ADR-005 D3) ────────────────────────────

describe("checkExpiry once-per-process warnings", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetWarningFlagsForTests();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    __resetWarningFlagsForTests();
  });

  it("emits console.warn on expired snapshot", () => {
    const mgr = new TrustRootManager(expiredSnap(), { disableRefresh: true });
    expect(mgr.checkExpiry()).toBe("expired");
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(String(warnSpy.mock.calls[0]![0])).toContain("expired");
  });

  it("expired warning fires only once across repeated calls", () => {
    const mgr = new TrustRootManager(expiredSnap(), { disableRefresh: true });
    mgr.checkExpiry();
    mgr.checkExpiry();
    mgr.checkExpiry();
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("emits console.warn at half-life", () => {
    const mgr = new TrustRootManager(halfLifeSnap(), { disableRefresh: true });
    expect(mgr.checkExpiry()).toBe("half_life");
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(String(warnSpy.mock.calls[0]![0])).toContain("half-life");
  });

  it("half-life warning fires only once across repeated calls", () => {
    const mgr = new TrustRootManager(halfLifeSnap(), { disableRefresh: true });
    mgr.checkExpiry();
    mgr.checkExpiry();
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("no warning when snapshot is fresh", () => {
    const mgr = new TrustRootManager(makeSnap(), { disableRefresh: true });
    mgr.checkExpiry();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("__resetWarningFlagsForTests allows a second warning to fire", () => {
    const mgr = new TrustRootManager(expiredSnap(), { disableRefresh: true });
    mgr.checkExpiry(); // first warning
    __resetWarningFlagsForTests();
    mgr.checkExpiry(); // second warning (flags were reset)
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});

// ─── verifyAuditBundle fail-closed expiry (ADR-005 D3) ───────────────────────────────

describe("verifyAuditBundle fail-closed expiry", () => {
  it("throws BundleVerificationError when snapshot is expired", async () => {
    await expect(
      verifyAuditBundle(EMPTY_BUNDLE, [], { trustRoot: expiredSnap() }),
    ).rejects.toBeInstanceOf(BundleVerificationError);
  });

  it("thrown error has reason=trust_snapshot_expired", async () => {
    await expect(
      verifyAuditBundle(EMPTY_BUNDLE, [], { trustRoot: expiredSnap() }),
    ).rejects.toMatchObject({
      reason: "trust_snapshot_expired",
      snapshotValidUntil: "2020-01-01T00:00:00Z",
    });
  });

  it("does NOT throw when allowExpiredSnapshot=true", async () => {
    const result = await verifyAuditBundle(EMPTY_BUNDLE, [], {
      trustRoot: expiredSnap(),
      allowExpiredSnapshot: true,
    });
    expect(result).toBeDefined();
    // Chain fails (empty events with non-zero head hash) but no expiry throw
    expect(result.verified).toBe(false);
  });

  it("does NOT throw for a valid non-expired snapshot", async () => {
    const result = await verifyAuditBundle(EMPTY_BUNDLE, [], { trustRoot: makeSnap() });
    expect(result).toBeDefined();
  });
});

// ─── verifyBundle → global trust root auto-inject (B2.3) ────────────────────────────

describe("verifyBundle global trust-root auto-inject", () => {
  afterEach(() => {
    __setGlobalTrustRootManagerForTests(null);
  });

  it("picks up the global manager snapshot (expired → throws)", async () => {
    const expiredMgr = new TrustRootManager(expiredSnap(), { disableRefresh: true });
    __setGlobalTrustRootManagerForTests(expiredMgr);

    // verifyBundle accepts an object directly (no disk read needed)
    await expect(
      verifyBundle(EMPTY_BUNDLE),
    ).rejects.toBeInstanceOf(BundleVerificationError);
  });

  it("global manager is lazily created from vendor snapshot", () => {
    __setGlobalTrustRootManagerForTests(null);
    const mgr = getGlobalTrustRootManager({ disableRefresh: true });
    expect(mgr).toBeDefined();
    expect(mgr.getSnapshot().valid_until).toBeTruthy();
    mgr.stopRefresh();
  });

  it("verifyBundle uses provided trustRoot over global", async () => {
    // Global is expired, but explicit trustRoot is valid → no expiry throw
    const expiredMgr = new TrustRootManager(expiredSnap(), { disableRefresh: true });
    __setGlobalTrustRootManagerForTests(expiredMgr);

    const result = await verifyBundle(EMPTY_BUNDLE, {
      trustRoot: makeSnap(),
      allowExpiredSnapshot: false,
    });
    expect(result).toBeDefined(); // no throw
  });
});
