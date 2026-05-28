/**
 * B3.1 — Bootstrap smoke test.
 *
 * Verifies that the vendor snapshot loads cleanly on process start:
 * getGlobalTrustRootManager().getSnapshot() should return a snapshot
 * with a valid_until that parses as an ISO-8601 date, non-empty issued_at,
 * and arrays for keys / revoked_keys / revoked_identities.
 * No exceptions should be thrown.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  __setGlobalTrustRootManagerForTests,
  getGlobalTrustRootManager,
} from "../src/trustRoot.js";

describe("B3.1 bootstrap smoke test", () => {
  afterEach(() => {
    __setGlobalTrustRootManagerForTests(null);
  });

  it("getGlobalTrustRootManager() returns a manager without throwing", () => {
    expect(() => getGlobalTrustRootManager({ disableRefresh: true })).not.toThrow();
  });

  it("vendor snapshot has a parseable valid_until", () => {
    const mgr = getGlobalTrustRootManager({ disableRefresh: true });
    const snap = mgr.getSnapshot();
    expect(snap.valid_until).toBeTruthy();
    const parsed = new Date(snap.valid_until);
    expect(Number.isFinite(parsed.getTime())).toBe(true);
  });

  it("vendor snapshot has a parseable issued_at", () => {
    const mgr = getGlobalTrustRootManager({ disableRefresh: true });
    const snap = mgr.getSnapshot();
    expect(snap.issued_at).toBeTruthy();
    const parsed = new Date(snap.issued_at);
    expect(Number.isFinite(parsed.getTime())).toBe(true);
  });

  it("vendor snapshot issued_at is in the past", () => {
    const mgr = getGlobalTrustRootManager({ disableRefresh: true });
    const snap = mgr.getSnapshot();
    const issuedAt = new Date(snap.issued_at).getTime();
    expect(issuedAt).toBeLessThan(Date.now());
  });

  it("vendor snapshot has arrays for keys, revoked_keys, revoked_identities", () => {
    const mgr = getGlobalTrustRootManager({ disableRefresh: true });
    const snap = mgr.getSnapshot();
    expect(Array.isArray(snap.keys)).toBe(true);
    expect(Array.isArray(snap.revoked_keys)).toBe(true);
    expect(Array.isArray(snap.revoked_identities)).toBe(true);
  });

  it("vendor snapshot has at least one key", () => {
    const mgr = getGlobalTrustRootManager({ disableRefresh: true });
    const snap = mgr.getSnapshot();
    expect(snap.keys.length).toBeGreaterThan(0);
  });

  it("each key has the required fields (kid, role, kty, alg)", () => {
    const mgr = getGlobalTrustRootManager({ disableRefresh: true });
    for (const key of mgr.getSnapshot().keys) {
      expect(typeof key.kid).toBe("string");
      expect(typeof key.role).toBe("string");
      expect(typeof key.kty).toBe("string");
      expect(typeof key.alg).toBe("string");
    }
  });

  it("getGlobalTrustRootManager is idempotent — same instance on repeated calls", () => {
    const m1 = getGlobalTrustRootManager({ disableRefresh: true });
    const m2 = getGlobalTrustRootManager({ disableRefresh: true });
    expect(m1).toBe(m2);
    m1.stopRefresh();
  });
});
