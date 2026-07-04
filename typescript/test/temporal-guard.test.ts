import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { TemporalGuard, TemporalGuardError, withTemporalGuard } from "../src/temporal-guard.js";
import type { AtlaSentClient } from "../src/client.js";
import type { VerifyPermitResponse } from "../src/types.js";

// Minimal mock of AtlaSentClient — only verifyPermit is used by TemporalGuard
function makeClient(
  verifyResult: Partial<VerifyPermitResponse> | (() => Promise<VerifyPermitResponse>),
): AtlaSentClient {
  const fn =
    typeof verifyResult === "function"
      ? verifyResult
      : async () =>
          ({
            verified: true,
            outcome: "verified",
            permitHash: "hash_test",
            timestamp: new Date().toISOString(),
            expiresAt: null,
            rateLimit: null,
            ...verifyResult,
          } satisfies VerifyPermitResponse);

  return { verifyPermit: vi.fn(fn) } as unknown as AtlaSentClient;
}

function freshContext(offsetMs = 0) {
  return {
    contextBuiltAt: new Date(Date.now() - offsetMs).toISOString(),
    contextSourceId: "mem-store-001",
  };
}

// Build a base64url-encoded pt.v2 permit token with the given issued_at_ms
function makePermitToken(issuedAtMs: number): string {
  const payload = JSON.stringify({ issued_at_ms: issuedAtMs, org_id: "org-1" });
  const b64 = btoa(payload).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  return `pt.v2.${b64}.fakesig`;
}

describe("TemporalGuardError", () => {
  it("sets name, code, message, and details", () => {
    const err = new TemporalGuardError("CONTEXT_STALE", "stale", { ageMs: 999 });
    expect(err.name).toBe("TemporalGuardError");
    expect(err.code).toBe("CONTEXT_STALE");
    expect(err.message).toBe("stale");
    expect(err.details).toEqual({ ageMs: 999 });
    expect(err).toBeInstanceOf(Error);
  });

  it("works without details", () => {
    const err = new TemporalGuardError("PERMIT_REVOKED", "revoked");
    expect(err.details).toBeUndefined();
  });
});

describe("TemporalGuard — pre-check 1: context freshness", () => {
  it("allows execution when context is fresh", async () => {
    const client = makeClient({});
    const guard = new TemporalGuard(client, {
      actionType: "agent.memory.write",
      maxContextAgeMs: 60_000,
    });
    const result = await guard.run(makePermitToken(Date.now()), freshContext(1_000), async () => 42);
    expect(result.value).toBe(42);
    expect(result.revalidationCount).toBe(0);
  });

  it("throws CONTEXT_STALE when context is too old", async () => {
    const client = makeClient({});
    const guard = new TemporalGuard(client, {
      actionType: "agent.memory.write",
      maxContextAgeMs: 5_000,
    });
    await expect(
      guard.run(makePermitToken(Date.now()), freshContext(10_000), async () => 42),
    ).rejects.toMatchObject({ code: "CONTEXT_STALE", name: "TemporalGuardError" });
  });

  it("throws CONTEXT_STALE when contextBuiltAt is missing", async () => {
    const client = makeClient({});
    const guard = new TemporalGuard(client, {
      actionType: "agent.memory.write",
      maxContextAgeMs: 5_000,
    });
    await expect(
      guard.run(makePermitToken(Date.now()), {}, async () => 42),
    ).rejects.toMatchObject({ code: "CONTEXT_STALE" });
  });

  it("throws CONTEXT_STALE when contextBuiltAt is not parseable", async () => {
    const client = makeClient({});
    const guard = new TemporalGuard(client, {
      actionType: "agent.memory.write",
      maxContextAgeMs: 5_000,
    });
    await expect(
      guard.run(makePermitToken(Date.now()), { contextBuiltAt: "not-a-date" }, async () => 42),
    ).rejects.toMatchObject({ code: "CONTEXT_STALE" });
  });

  it("skips context check when maxContextAgeMs is not set", async () => {
    const client = makeClient({});
    const guard = new TemporalGuard(client, { actionType: "agent.memory.write" });
    // Context is ancient — no check → should succeed
    const result = await guard.run(makePermitToken(Date.now()), freshContext(999_999), async () => "ok");
    expect(result.value).toBe("ok");
  });
});

describe("TemporalGuard — pre-check 2: async execution deadline", () => {
  it("throws EXECUTION_DEADLINE_EXCEEDED when deadline has passed (string)", async () => {
    const client = makeClient({});
    const pastDeadline = new Date(Date.now() - 1000).toISOString();
    const guard = new TemporalGuard(client, {
      actionType: "agent.deploy",
      executeBefore: pastDeadline,
    });
    await expect(
      guard.run(makePermitToken(Date.now()), freshContext(), async () => 42),
    ).rejects.toMatchObject({ code: "EXECUTION_DEADLINE_EXCEEDED" });
  });

  it("throws EXECUTION_DEADLINE_EXCEEDED when deadline has passed (Date)", async () => {
    const client = makeClient({});
    const guard = new TemporalGuard(client, {
      actionType: "agent.deploy",
      executeBefore: new Date(Date.now() - 500),
    });
    await expect(
      guard.run(makePermitToken(Date.now()), freshContext(), async () => 42),
    ).rejects.toMatchObject({ code: "EXECUTION_DEADLINE_EXCEEDED" });
  });

  it("allows execution when deadline is in the future", async () => {
    const client = makeClient({});
    const guard = new TemporalGuard(client, {
      actionType: "agent.deploy",
      executeBefore: new Date(Date.now() + 10_000),
    });
    const result = await guard.run(makePermitToken(Date.now()), freshContext(), async () => "done");
    expect(result.value).toBe("done");
  });
});

describe("TemporalGuard — pre-check 3: permit freshness", () => {
  it("throws PERMIT_NOT_FRESH when permit is too old", async () => {
    const client = makeClient({});
    const oldIssuedAt = Date.now() - 120_000; // 2 min ago
    const guard = new TemporalGuard(client, {
      actionType: "agent.write",
      maxPermitAgeMs: 60_000, // max 1 min
    });
    await expect(
      guard.run(makePermitToken(oldIssuedAt), freshContext(), async () => 42),
    ).rejects.toMatchObject({ code: "PERMIT_NOT_FRESH" });
  });

  it("allows execution when permit is fresh", async () => {
    const client = makeClient({});
    const guard = new TemporalGuard(client, {
      actionType: "agent.write",
      maxPermitAgeMs: 60_000,
    });
    const result = await guard.run(makePermitToken(Date.now() - 1_000), freshContext(), async () => "ok");
    expect(result.value).toBe("ok");
  });

  it("skips freshness check for legacy UUID tokens (no pt.v2. prefix)", async () => {
    const client = makeClient({});
    const guard = new TemporalGuard(client, {
      actionType: "agent.write",
      maxPermitAgeMs: 1, // very tight — would fail if checked
    });
    const result = await guard.run("legacy-uuid-permit", freshContext(), async () => "ok");
    expect(result.value).toBe("ok");
  });

  it("fails closed on malformed pt.v2 token (no dot after payload)", async () => {
    const client = makeClient({});
    const guard = new TemporalGuard(client, {
      actionType: "agent.write",
      maxPermitAgeMs: 60_000,
    });
    await expect(
      guard.run("pt.v2.nodot", freshContext(), async () => 42),
    ).rejects.toMatchObject({ code: "PERMIT_NOT_FRESH" });
  });

  it("fails closed on pt.v2 token missing issued_at_ms", async () => {
    const client = makeClient({});
    const payload = btoa(JSON.stringify({ org_id: "org-1" }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    const guard = new TemporalGuard(client, {
      actionType: "agent.write",
      maxPermitAgeMs: 60_000,
    });
    await expect(
      guard.run(`pt.v2.${payload}.sig`, freshContext(), async () => 42),
    ).rejects.toMatchObject({ code: "PERMIT_NOT_FRESH" });
  });

  it("skips permit freshness check when maxPermitAgeMs is not set", async () => {
    const client = makeClient({});
    const guard = new TemporalGuard(client, { actionType: "agent.write" });
    const result = await guard.run(makePermitToken(0), freshContext(), async () => "ok");
    expect(result.value).toBe("ok");
  });

  it("skips freshness check for pt.v3.* tokens (no iat client-side)", async () => {
    const client = makeClient({});
    const guard = new TemporalGuard(client, {
      actionType: "agent.write",
      maxPermitAgeMs: 1, // very tight — would fail if checked
    });
    const result = await guard.run("pt.v3.fakepayload.fakesig", freshContext(), async () => "ok");
    expect(result.value).toBe("ok");
  });
});

// Build a pt.v4.* COSE Sign1 token with the given iat (Unix seconds).
// Does NOT produce a valid Ed25519 signature (all-zero bytes) — only suitable
// for testing checkPermitFreshness which is client-side and skips sig verification.
function makeV4Token(iatSec: number): string {
  // permit_claims CBOR map: {4: 0, 6: iatSec}
  // Keys must be in canonical order (RFC 8949 §4.2.1): 4 before 6.
  const encUint = (n: number): number[] => {
    if (n <= 23) return [n];
    if (n <= 0xff) return [0x18, n];
    if (n <= 0xffff) return [0x19, n >> 8, n & 0xff];
    return [0x1a, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  };
  const payload = Uint8Array.from([
    0xa2,       // map(2)
    0x04, 0x00, // key 4 (exp) = 0
    0x06, ...encUint(iatSec), // key 6 (iat) = iatSec
  ]);

  // COSE_Sign1 components
  const protectedHdr = [0xa1, 0x01, 0x27]; // {1: -8} = EdDSA
  const emptyMap = [0xa0];
  const sig = new Array(64).fill(0); // all-zero signature (not verified client-side)

  // Encode bstr(protectedHdr): 0x43 a1 01 27
  const protectedBstr = [0x43, ...protectedHdr];

  // Encode bstr(payload): 0x40|len or 0x58 len (payload.length <= 23 guaranteed for test payloads)
  const payloadBstr =
    payload.length <= 23
      ? [0x40 | payload.length, ...payload]
      : [0x58, payload.length, ...payload];

  // Encode bstr(sig): 0x58 0x40 <64 bytes>
  const sigBstr = [0x58, 0x40, ...sig];

  // COSE_Sign1 = d2 84 [protectedBstr, {}, payloadBstr, sigBstr]
  const coseBytes = Uint8Array.from([
    0xd2, // tag(18)
    0x84, // array(4)
    ...protectedBstr,
    ...emptyMap,
    ...payloadBstr,
    ...sigBstr,
  ]);

  const binary = String.fromCharCode(...coseBytes);
  const b64 = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  return `pt.v4.${b64}`;
}

describe("TemporalGuard — pre-check 3: permit freshness (pt.v4.*)", () => {
  it("throws PERMIT_NOT_FRESH when pt.v4 permit is too old", async () => {
    const client = makeClient({});
    const oldIatSec = Math.floor((Date.now() - 120_000) / 1000); // 2 min ago
    const guard = new TemporalGuard(client, {
      actionType: "agent.write",
      maxPermitAgeMs: 60_000,
    });
    await expect(
      guard.run(makeV4Token(oldIatSec), freshContext(), async () => 42),
    ).rejects.toMatchObject({ code: "PERMIT_NOT_FRESH" });
  });

  it("allows execution when pt.v4 permit is fresh", async () => {
    const client = makeClient({});
    const iatSec = Math.floor((Date.now() - 1_000) / 1000);
    const guard = new TemporalGuard(client, {
      actionType: "agent.write",
      maxPermitAgeMs: 60_000,
    });
    const result = await guard.run(makeV4Token(iatSec), freshContext(), async () => "ok");
    expect(result.value).toBe("ok");
  });

  it("fails closed on malformed pt.v4 token (invalid base64url)", async () => {
    const client = makeClient({});
    const guard = new TemporalGuard(client, {
      actionType: "agent.write",
      maxPermitAgeMs: 60_000,
    });
    await expect(
      guard.run("pt.v4.!!!notbase64!!!", freshContext(), async () => 42),
    ).rejects.toMatchObject({ code: "PERMIT_NOT_FRESH" });
  });

  it("fails closed on pt.v4 token with valid base64 but non-COSE bytes", async () => {
    const client = makeClient({});
    const garbage = btoa("this is not COSE").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    const guard = new TemporalGuard(client, {
      actionType: "agent.write",
      maxPermitAgeMs: 60_000,
    });
    await expect(
      guard.run(`pt.v4.${garbage}`, freshContext(), async () => 42),
    ).rejects.toMatchObject({ code: "PERMIT_NOT_FRESH" });
  });

  it("fails closed on pt.v4 token with empty payload after prefix", async () => {
    const client = makeClient({});
    const guard = new TemporalGuard(client, {
      actionType: "agent.write",
      maxPermitAgeMs: 60_000,
    });
    await expect(
      guard.run("pt.v4.", freshContext(), async () => 42),
    ).rejects.toMatchObject({ code: "PERMIT_NOT_FRESH" });
  });

  it("skips pt.v4 freshness check when maxPermitAgeMs is not set", async () => {
    const client = makeClient({});
    const guard = new TemporalGuard(client, { actionType: "agent.write" });
    const result = await guard.run(makeV4Token(0), freshContext(), async () => "ok");
    expect(result.value).toBe("ok");
  });
});

describe("TemporalGuard — revalidation during execution", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("calls verifyPermit on the revalidation interval", async () => {
    const client = makeClient({ verified: true, outcome: "verified" });
    const guard = new TemporalGuard(client, {
      actionType: "agent.write",
      revalidationIntervalMs: 100,
    });

    const promise = guard.run(makePermitToken(Date.now()), freshContext(), async () => {
      await vi.advanceTimersByTimeAsync(250); // triggers 2 intervals
      return "done";
    });

    const result = await promise;
    expect(result.value).toBe("done");
    expect(result.revalidationCount).toBe(2);
    expect(client.verifyPermit).toHaveBeenCalledTimes(2);
  });

  it("throws PERMIT_REVOKED when permit is revoked during execution", async () => {
    const client = makeClient({ verified: false, outcome: "consumed" });
    const guard = new TemporalGuard(client, {
      actionType: "agent.write",
      revalidationIntervalMs: 50,
    });

    const fn = async () => {
      await vi.advanceTimersByTimeAsync(100);
      return "done";
    };

    await expect(guard.run(makePermitToken(Date.now()), freshContext(), fn))
      .rejects.toMatchObject({ code: "PERMIT_REVOKED" });
  });

  it("calls onPermitRevoked callback when permit is revoked", async () => {
    const revocationCallback = vi.fn();
    const client = makeClient({ verified: false, outcome: "consumed" });
    const guard = new TemporalGuard(client, {
      actionType: "agent.write",
      revalidationIntervalMs: 50,
      onPermitRevoked: revocationCallback,
    });

    await expect(
      guard.run(makePermitToken(Date.now()), freshContext(), async () => {
        await vi.advanceTimersByTimeAsync(100);
        return "done";
      }),
    ).rejects.toMatchObject({ code: "PERMIT_REVOKED" });

    expect(revocationCallback).toHaveBeenCalledWith("consumed");
  });

  it("throws REVALIDATION_FAILED when verifyPermit throws during execution", async () => {
    const client = makeClient(async () => { throw new Error("network error"); });
    const guard = new TemporalGuard(client, {
      actionType: "agent.write",
      revalidationIntervalMs: 50,
    });

    await expect(
      guard.run(makePermitToken(Date.now()), freshContext(), async () => {
        await vi.advanceTimersByTimeAsync(100);
        return "done";
      }),
    ).rejects.toMatchObject({ code: "REVALIDATION_FAILED" });
  });

  it("does not set up revalidation timer when revalidationIntervalMs is 0", async () => {
    const client = makeClient({});
    const guard = new TemporalGuard(client, {
      actionType: "agent.write",
      revalidationIntervalMs: 0,
    });
    const result = await guard.run(makePermitToken(Date.now()), freshContext(), async () => "ok");
    expect(result.value).toBe("ok");
    expect(client.verifyPermit).not.toHaveBeenCalled();
  });

  it("returns elapsed time and revalidation count in result", async () => {
    const client = makeClient({ verified: true, outcome: "verified" });
    const guard = new TemporalGuard(client, {
      actionType: "agent.write",
      revalidationIntervalMs: 100,
    });

    const result = await guard.run(makePermitToken(Date.now()), freshContext(), async () => {
      await vi.advanceTimersByTimeAsync(300);
      return "value";
    });

    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.revalidationCount).toBeGreaterThan(0);
    expect(result.value).toBe("value");
  });
});

describe("withTemporalGuard", () => {
  it("is equivalent to TemporalGuard.run()", async () => {
    const client = makeClient({});
    const result = await withTemporalGuard(
      client,
      makePermitToken(Date.now()),
      freshContext(),
      { actionType: "agent.write" },
      async () => "from-wrapper",
    );
    expect(result.value).toBe("from-wrapper");
    expect(result.revalidationCount).toBe(0);
  });

  it("propagates CONTEXT_STALE from the guard", async () => {
    const client = makeClient({});
    await expect(
      withTemporalGuard(
        client,
        makePermitToken(Date.now()),
        { contextBuiltAt: new Date(Date.now() - 999_999).toISOString() },
        { actionType: "agent.write", maxContextAgeMs: 1_000 },
        async () => "never",
      ),
    ).rejects.toMatchObject({ code: "CONTEXT_STALE" });
  });
});
