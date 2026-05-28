/**
 * B3.2 — Refresh integration test.
 *
 * Verifies that _doRefresh() against a mock fetch updates the in-memory
 * snapshot: valid_until / keys / revoked_keys all reflect the mock
 * response, and failures are silent (snapshot preserved).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TrustRootManager,
  __setGlobalTrustRootManagerForTests,
  type TrustRootSnapshot,
} from "../src/trustRoot.js";

function makeSnap(overrides: Partial<TrustRootSnapshot> = {}): TrustRootSnapshot {
  return {
    valid_until: "2026-06-01T00:00:00Z",
    issued_at: "2026-01-01T00:00:00Z",
    keys: [],
    revoked_keys: [],
    revoked_identities: [],
    ...overrides,
  };
}

type MockFetchArgs = {
  validUntil?: string;
  issuedAt?: string;
  keys?: unknown[];
  revokedKeys?: unknown[];
};

function makeMockFetch(overrides: MockFetchArgs = {}) {
  const validUntil = overrides.validUntil ?? "2030-01-01T00:00:00Z";
  const issuedAt = overrides.issuedAt ?? "2026-01-01T00:00:00Z";
  const keys = overrides.keys ?? [
    { kid: "refreshed-key", role: "R3_audit", kty: "OKP", crv: "Ed25519", alg: "EdDSA", x: "abc" },
  ];
  const revokedKeys = overrides.revokedKeys ?? [];

  const responses: Record<string, unknown> = {
    "atlasent-trust-root.json": { valid_until: validUntil, issued_at: issuedAt },
    "atlasent-verifier-keys.json": { keys },
    "atlasent-revocations.json": { revoked_keys: revokedKeys, revoked_identities: [] },
  };

  return vi.fn(async (url: string) => {
    const lastPart = (url as string).split("/").pop()!;
    const data = responses[lastPart];
    if (!data) {
      return { ok: false, json: () => Promise.resolve({}) } as unknown as Response;
    }
    return {
      ok: true,
      json: () => Promise.resolve(data),
    } as unknown as Response;
  });
}

type WithDoRefresh = { _doRefresh(): Promise<void> };

describe("B3.2 refresh integration test", () => {
  afterEach(() => {
    __setGlobalTrustRootManagerForTests(null);
  });

  it("_doRefresh updates valid_until from mock server", async () => {
    const initial = makeSnap({ valid_until: "2026-06-01T00:00:00Z" });
    const mgr = new TrustRootManager(initial, {
      disableRefresh: true,
      fetch: makeMockFetch({ validUntil: "2030-01-01T00:00:00Z" }),
    });

    expect(mgr.getSnapshot().valid_until).toBe("2026-06-01T00:00:00Z");
    await (mgr as unknown as WithDoRefresh)._doRefresh();
    expect(mgr.getSnapshot().valid_until).toBe("2030-01-01T00:00:00Z");
  });

  it("_doRefresh updates keys from mock server", async () => {
    const mgr = new TrustRootManager(makeSnap(), {
      disableRefresh: true,
      fetch: makeMockFetch({
        keys: [
          { kid: "new-key", role: "R3_audit", kty: "OKP", crv: "Ed25519", alg: "EdDSA", x: "xyz" },
        ],
      }),
    });

    await (mgr as unknown as WithDoRefresh)._doRefresh();
    const keys = mgr.getSnapshot().keys;
    expect(keys).toHaveLength(1);
    expect(keys[0]!.kid).toBe("new-key");
  });

  it("_doRefresh updates revoked_keys; isRevoked reflects new state", async () => {
    const mgr = new TrustRootManager(makeSnap(), {
      disableRefresh: true,
      fetch: makeMockFetch({
        revokedKeys: [
          { kid: "bad-key", revoked_at: "2026-01-01T00:00:00Z", reason: "compromise" },
        ],
      }),
    });

    expect(mgr.isRevoked("bad-key")).toBe(false);
    await (mgr as unknown as WithDoRefresh)._doRefresh();
    expect(mgr.isRevoked("bad-key")).toBe(true);
  });

  it("_doRefresh is silent on network error — snapshot unchanged", async () => {
    const originalSnap = makeSnap({ valid_until: "2026-06-01T00:00:00Z" });
    const failFetch = vi.fn(async () => {
      throw new Error("network failure");
    });
    const mgr = new TrustRootManager(originalSnap, {
      disableRefresh: true,
      fetch: failFetch as unknown as typeof fetch,
    });

    await (mgr as unknown as WithDoRefresh)._doRefresh();
    expect(mgr.getSnapshot().valid_until).toBe("2026-06-01T00:00:00Z");
  });

  it("_doRefresh is silent on non-ok HTTP response — snapshot unchanged", async () => {
    const originalSnap = makeSnap({ valid_until: "2026-06-01T00:00:00Z" });
    const mgr = new TrustRootManager(originalSnap, {
      disableRefresh: true,
      fetch: vi.fn(async () => ({ ok: false, json: () => Promise.resolve({}) } as unknown as Response)),
    });

    await (mgr as unknown as WithDoRefresh)._doRefresh();
    expect(mgr.getSnapshot().valid_until).toBe("2026-06-01T00:00:00Z");
  });

  it("_doRefresh is silent when response missing valid_until — snapshot unchanged", async () => {
    const originalSnap = makeSnap({ valid_until: "2026-06-01T00:00:00Z" });
    const mgr = new TrustRootManager(originalSnap, {
      disableRefresh: true,
      fetch: vi.fn(async (url: string) => {
        const lastPart = (url as string).split("/").pop()!;
        const data: Record<string, unknown> = {
          "atlasent-trust-root.json": {}, // missing valid_until
          "atlasent-verifier-keys.json": { keys: [] },
          "atlasent-revocations.json": { revoked_keys: [], revoked_identities: [] },
        };
        return {
          ok: true,
          json: () => Promise.resolve(data[lastPart] ?? {}),
        } as unknown as Response;
      }),
    });

    await (mgr as unknown as WithDoRefresh)._doRefresh();
    expect(mgr.getSnapshot().valid_until).toBe("2026-06-01T00:00:00Z");
  });
});
