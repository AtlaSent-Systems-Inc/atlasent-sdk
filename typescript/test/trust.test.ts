/**
 * Trust-root Phase 2 — unit tests for typescript/src/trust.ts.
 *
 * Covers:
 *   - bootstrapTrust(): successful fetch, fallback on failure, pinned
 *     snapshot passthrough, shape validation, expires_at derivation.
 *   - isTrustSnapshotExpired(): TTL-based expiry, expires_at override,
 *     fresh snapshot passes, boundary conditions.
 *   - isKidRevoked(): presence in list, absence, empty list.
 */

import { describe, expect, it, vi } from "vitest";
import {
  bootstrapTrust,
  DEFAULT_TRUST_TTL_MS,
  isKidRevoked,
  isTrustSnapshotExpired,
  type JWK,
  type TrustSnapshot,
} from "../src/trust.js";

// ─── Helpers ───────────────────────────────────────────────────────────────────

function freshSnapshot(overrides: Partial<TrustSnapshot> = {}): TrustSnapshot {
  const now = Date.now();
  return {
    keys: [{ kid: "k1", kty: "OKP" }],
    revoked_kids: ["revoked-k1"],
    fetched_at: now,
    expires_at: now + DEFAULT_TRUST_TTL_MS,
    ...overrides,
  };
}

function mockFetch(
  status: number,
  body: unknown,
  opts: { throws?: Error } = {},
): typeof fetch {
  if (opts.throws) {
    return vi.fn(() => Promise.reject(opts.throws)) as unknown as typeof fetch;
  }
  return vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  ) as unknown as typeof fetch;
}

// ─── bootstrapTrust ────────────────────────────────────────────────────────────

describe("bootstrapTrust", () => {
  it("returns a TrustSnapshot on a successful fetch", async () => {
    const wireBody = {
      keys: [{ kid: "key-1", kty: "OKP", crv: "Ed25519", alg: "EdDSA", x: "abc" }],
      revoked_kids: ["old-key"],
    };
    const snap = await bootstrapTrust(
      "https://api.atlasent.io",
      undefined,
      DEFAULT_TRUST_TTL_MS,
      mockFetch(200, wireBody),
    );

    expect(snap.keys).toHaveLength(1);
    expect(snap.keys[0]!.kid).toBe("key-1");
    expect(snap.revoked_kids).toEqual(["old-key"]);
    expect(typeof snap.fetched_at).toBe("number");
    expect(typeof snap.expires_at).toBe("number");
    expect(snap.expires_at).toBeGreaterThan(snap.fetched_at);
  });

  it("fetches from /.well-known/atlasent-keys.json relative to baseUrl", async () => {
    const fetchMock = mockFetch(200, { keys: [], revoked_kids: [] });
    await bootstrapTrust("https://api.atlasent.io", undefined, DEFAULT_TRUST_TTL_MS, fetchMock);
    const calledUrl = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(calledUrl).toBe("https://api.atlasent.io/.well-known/atlasent-keys.json");
  });

  it("strips trailing slashes from baseUrl before appending the path", async () => {
    const fetchMock = mockFetch(200, { keys: [], revoked_kids: [] });
    await bootstrapTrust("https://api.atlasent.io///", undefined, DEFAULT_TRUST_TTL_MS, fetchMock);
    const calledUrl = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(calledUrl).toBe("https://api.atlasent.io/.well-known/atlasent-keys.json");
  });

  it("derives expires_at from server valid_until when present", async () => {
    const validUntil = "2099-01-01T00:00:00Z";
    const wireBody = { keys: [], revoked_kids: [], valid_until: validUntil };
    const snap = await bootstrapTrust(
      "https://api.atlasent.io",
      undefined,
      DEFAULT_TRUST_TTL_MS,
      mockFetch(200, wireBody),
    );
    expect(snap.expires_at).toBe(new Date(validUntil).getTime());
  });

  it("falls back to fetched_at + ttlMs when valid_until is absent", async () => {
    const wireBody = { keys: [], revoked_kids: [] };
    const before = Date.now();
    const snap = await bootstrapTrust(
      "https://api.atlasent.io",
      undefined,
      DEFAULT_TRUST_TTL_MS,
      mockFetch(200, wireBody),
    );
    const after = Date.now();
    // expires_at should be approximately fetched_at + ttlMs
    expect(snap.expires_at).toBeGreaterThanOrEqual(before + DEFAULT_TRUST_TTL_MS);
    expect(snap.expires_at).toBeLessThanOrEqual(after + DEFAULT_TRUST_TTL_MS);
  });

  it("accepts revoked_keys (object array) as fallback for revoked_kids", async () => {
    const wireBody = {
      keys: [],
      revoked_keys: [
        { kid: "bad-key-1", revoked_at: "2026-01-01T00:00:00Z" },
        { kid: "bad-key-2", revoked_at: "2026-01-02T00:00:00Z" },
      ],
    };
    const snap = await bootstrapTrust(
      "https://api.atlasent.io",
      undefined,
      DEFAULT_TRUST_TTL_MS,
      mockFetch(200, wireBody),
    );
    expect(snap.revoked_kids).toContain("bad-key-1");
    expect(snap.revoked_kids).toContain("bad-key-2");
  });

  it("filters out keys missing kid or kty fields", async () => {
    const wireBody = {
      keys: [
        { kid: "valid-key", kty: "OKP" },
        { kty: "OKP" }, // missing kid
        { kid: "no-kty-key" }, // missing kty
        null, // null entry
        42, // non-object
      ],
    };
    const snap = await bootstrapTrust(
      "https://api.atlasent.io",
      undefined,
      DEFAULT_TRUST_TTL_MS,
      mockFetch(200, wireBody),
    );
    expect(snap.keys).toHaveLength(1);
    expect(snap.keys[0]!.kid).toBe("valid-key");
  });

  it("returns pinnedSnapshot on network failure (silent fallback)", async () => {
    const pinned = freshSnapshot();
    const snap = await bootstrapTrust(
      "https://api.atlasent.io",
      pinned,
      DEFAULT_TRUST_TTL_MS,
      mockFetch(200, {}, { throws: new Error("network failure") }),
    );
    expect(snap).toBe(pinned);
  });

  it("returns pinnedSnapshot on non-ok HTTP response", async () => {
    const pinned = freshSnapshot();
    const snap = await bootstrapTrust(
      "https://api.atlasent.io",
      pinned,
      DEFAULT_TRUST_TTL_MS,
      mockFetch(500, { error: "server error" }),
    );
    expect(snap).toBe(pinned);
  });

  it("throws on network failure when no pinnedSnapshot is provided", async () => {
    await expect(
      bootstrapTrust(
        "https://api.atlasent.io",
        undefined,
        DEFAULT_TRUST_TTL_MS,
        mockFetch(200, {}, { throws: new Error("network failure") }),
      ),
    ).rejects.toThrow("network failure");
  });

  it("throws on non-ok HTTP when no pinnedSnapshot is provided", async () => {
    await expect(
      bootstrapTrust(
        "https://api.atlasent.io",
        undefined,
        DEFAULT_TRUST_TTL_MS,
        mockFetch(404, {}),
      ),
    ).rejects.toThrow(/HTTP 404/);
  });

  it("accepts a custom ttlMs for expires_at fallback", async () => {
    const customTtl = 60 * 1000; // 1 minute
    const wireBody = { keys: [], revoked_kids: [] };
    const before = Date.now();
    const snap = await bootstrapTrust(
      "https://api.atlasent.io",
      undefined,
      customTtl,
      mockFetch(200, wireBody),
    );
    const after = Date.now();
    expect(snap.expires_at).toBeGreaterThanOrEqual(before + customTtl);
    expect(snap.expires_at).toBeLessThanOrEqual(after + customTtl);
  });

  it("handles empty revoked_kids array in response", async () => {
    const wireBody = { keys: [], revoked_kids: [] };
    const snap = await bootstrapTrust(
      "https://api.atlasent.io",
      undefined,
      DEFAULT_TRUST_TTL_MS,
      mockFetch(200, wireBody),
    );
    expect(snap.revoked_kids).toEqual([]);
  });

  it("handles missing revoked_kids and revoked_keys (defaults to empty)", async () => {
    const wireBody = { keys: [{ kid: "k1", kty: "OKP" }] };
    const snap = await bootstrapTrust(
      "https://api.atlasent.io",
      undefined,
      DEFAULT_TRUST_TTL_MS,
      mockFetch(200, wireBody),
    );
    expect(snap.revoked_kids).toEqual([]);
  });

  it("preserves extra JWK fields on key objects", async () => {
    const wireBody = {
      keys: [{ kid: "k1", kty: "OKP", crv: "Ed25519", alg: "EdDSA", x: "payload" }],
    };
    const snap = await bootstrapTrust(
      "https://api.atlasent.io",
      undefined,
      DEFAULT_TRUST_TTL_MS,
      mockFetch(200, wireBody),
    );
    const key = snap.keys[0] as JWK & { crv?: string; alg?: string; x?: string };
    expect(key.crv).toBe("Ed25519");
    expect(key.alg).toBe("EdDSA");
    expect(key.x).toBe("payload");
  });
});

// ─── isTrustSnapshotExpired ────────────────────────────────────────────────────

describe("isTrustSnapshotExpired", () => {
  it("returns false for a fresh snapshot (expires_at in the future)", () => {
    const now = Date.now();
    const snap = freshSnapshot({
      fetched_at: now - 60_000, // 1 minute ago
      expires_at: now + DEFAULT_TRUST_TTL_MS,
    });
    expect(isTrustSnapshotExpired(snap, DEFAULT_TRUST_TTL_MS, now)).toBe(false);
  });

  it("returns true when expires_at is in the past", () => {
    const now = Date.now();
    const snap = freshSnapshot({
      fetched_at: now - DEFAULT_TRUST_TTL_MS - 1,
      expires_at: now - 1000, // 1 second ago
    });
    expect(isTrustSnapshotExpired(snap, DEFAULT_TRUST_TTL_MS, now)).toBe(true);
  });

  it("returns true when age exceeds ttlMs even if expires_at is in the future", () => {
    const now = Date.now();
    const customTtl = 60 * 60 * 1000; // 1 hour TTL
    const snap = freshSnapshot({
      fetched_at: now - 2 * customTtl, // fetched 2 hours ago
      expires_at: now + DEFAULT_TRUST_TTL_MS, // far future expires_at
    });
    expect(isTrustSnapshotExpired(snap, customTtl, now)).toBe(true);
  });

  it("returns false when snapshot is exactly at the TTL boundary (not yet past)", () => {
    const now = Date.now();
    const snap = freshSnapshot({
      fetched_at: now - DEFAULT_TRUST_TTL_MS + 1000, // 1 second under TTL
      expires_at: now + 1000, // still valid
    });
    expect(isTrustSnapshotExpired(snap, DEFAULT_TRUST_TTL_MS, now)).toBe(false);
  });

  it("uses default 24h TTL when ttlMs is not supplied", () => {
    const now = Date.now();
    // Fetched just over 24h ago — should be expired
    const snap = freshSnapshot({
      fetched_at: now - DEFAULT_TRUST_TTL_MS - 1,
      expires_at: now + 1000, // expires_at is still in the future
    });
    // Called without explicit ttlMs — should default to 24h
    expect(isTrustSnapshotExpired(snap)).toBe(true);
  });

  it("uses Date.now() when nowMs is not supplied", () => {
    // A snapshot that expired well in the past
    const snap = freshSnapshot({
      fetched_at: 1_000_000, // epoch + 1 second
      expires_at: 2_000_000, // epoch + 2 seconds — far in the past
    });
    expect(isTrustSnapshotExpired(snap)).toBe(true);
  });

  it("is not expired right at fetched_at (0 age)", () => {
    const now = Date.now();
    const snap = freshSnapshot({
      fetched_at: now,
      expires_at: now + DEFAULT_TRUST_TTL_MS,
    });
    expect(isTrustSnapshotExpired(snap, DEFAULT_TRUST_TTL_MS, now)).toBe(false);
  });
});

// ─── isKidRevoked ──────────────────────────────────────────────────────────────

describe("isKidRevoked", () => {
  it("returns true when kid is in revoked_kids", () => {
    const snap = freshSnapshot({ revoked_kids: ["bad-key", "another-bad"] });
    expect(isKidRevoked(snap, "bad-key")).toBe(true);
  });

  it("returns true for the second revoked KID", () => {
    const snap = freshSnapshot({ revoked_kids: ["bad-key", "another-bad"] });
    expect(isKidRevoked(snap, "another-bad")).toBe(true);
  });

  it("returns false when kid is not in revoked_kids", () => {
    const snap = freshSnapshot({ revoked_kids: ["bad-key"] });
    expect(isKidRevoked(snap, "good-key")).toBe(false);
  });

  it("returns false when revoked_kids is empty", () => {
    const snap = freshSnapshot({ revoked_kids: [] });
    expect(isKidRevoked(snap, "any-key")).toBe(false);
  });

  it("is case-sensitive — different casing is not revoked", () => {
    const snap = freshSnapshot({ revoked_kids: ["BAD-KEY"] });
    expect(isKidRevoked(snap, "bad-key")).toBe(false);
    expect(isKidRevoked(snap, "BAD-KEY")).toBe(true);
  });

  it("returns false for empty string kid when list is non-empty", () => {
    const snap = freshSnapshot({ revoked_kids: ["k1", "k2"] });
    expect(isKidRevoked(snap, "")).toBe(false);
  });
});

// ─── Integration: fail-closed verify() path simulation ────────────────────────

describe("verify() path simulation (ADR-005 D3)", () => {
  it("expired snapshot + failClosedOnExpiry → deny", () => {
    const now = Date.now();
    const expiredSnap = freshSnapshot({
      fetched_at: now - DEFAULT_TRUST_TTL_MS - 1,
      expires_at: now - 1000,
    });
    const failClosedOnExpiry = true;

    // Simulate what verify() should do
    const isExpired = isTrustSnapshotExpired(expiredSnap, DEFAULT_TRUST_TTL_MS, now);
    const result =
      isExpired && failClosedOnExpiry
        ? { valid: false, reason: "TRUST_SNAPSHOT_EXPIRED" }
        : { valid: true };

    expect(result).toEqual({ valid: false, reason: "TRUST_SNAPSHOT_EXPIRED" });
  });

  it("expired snapshot + failClosedOnExpiry=false → not denied by expiry alone", () => {
    const now = Date.now();
    const expiredSnap = freshSnapshot({
      fetched_at: now - DEFAULT_TRUST_TTL_MS - 1,
      expires_at: now - 1000,
    });
    const failClosedOnExpiry = false;

    const isExpired = isTrustSnapshotExpired(expiredSnap, DEFAULT_TRUST_TTL_MS, now);
    const result =
      isExpired && failClosedOnExpiry
        ? { valid: false, reason: "TRUST_SNAPSHOT_EXPIRED" }
        : { valid: true };

    expect(result.valid).toBe(true);
  });

  it("revoked KID → deny regardless of expiry", () => {
    const snap = freshSnapshot({ revoked_kids: ["permit-signing-key"] });
    const permitKid = "permit-signing-key";

    const revoked = isKidRevoked(snap, permitKid);
    expect(revoked).toBe(true);
    // In verify(), revocation → { valid: false, reason: 'SIGNING_KEY_REVOKED' }
  });

  it("non-revoked KID with fresh snapshot → not denied by trust checks", () => {
    const now = Date.now();
    const snap = freshSnapshot({
      revoked_kids: ["other-key"],
      fetched_at: now,
      expires_at: now + DEFAULT_TRUST_TTL_MS,
    });
    const permitKid = "current-signing-key";

    const isExpired = isTrustSnapshotExpired(snap, DEFAULT_TRUST_TTL_MS, now);
    const revoked = isKidRevoked(snap, permitKid);

    expect(isExpired).toBe(false);
    expect(revoked).toBe(false);
  });
});

// ─── DEFAULT_TRUST_TTL_MS ──────────────────────────────────────────────────────

describe("DEFAULT_TRUST_TTL_MS", () => {
  it("is 24 hours in milliseconds", () => {
    expect(DEFAULT_TRUST_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});
