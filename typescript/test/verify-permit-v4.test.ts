/**
 * Tests for the pt.v4.* COSE Sign1 offline permit verifier (ADR-050).
 *
 * Generates real Ed25519 keys via crypto.subtle so the test is a real
 * sign → verify round-trip — not just structural parsing.
 */

import { describe, expect, it } from "vitest";
import { verifyPermitV4, PermitV4VerifyError, type PermitClaimsV4 } from "../src/verify-permit-v4.js";

// ─── CBOR helpers for token construction ──────────────────────────────────────

function cborUint(n: number): Uint8Array {
  if (n <= 23) return Uint8Array.of(n);
  if (n <= 0xff) return Uint8Array.of(24, n);
  if (n <= 0xffff) return Uint8Array.of(25, n >> 8, n & 0xff);
  return Uint8Array.of(26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

function cborNint(v: number): Uint8Array {
  const b = cborUint(v);
  b[0]! |= 0x20;
  return b;
}

function cborBstr(b: Uint8Array): Uint8Array {
  const head = cborUint(b.length);
  head[0]! |= 0x40;
  return concat([head, b]);
}

function cborTstr(s: string): Uint8Array {
  const b = new TextEncoder().encode(s);
  const head = cborUint(b.length);
  head[0]! |= 0x60;
  return concat([head, b]);
}

function cborArray(items: Uint8Array[]): Uint8Array {
  const head = cborUint(items.length);
  head[0]! |= 0x80;
  return concat([head, ...items]);
}

function concat(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toB64url(b: Uint8Array): string {
  const bin = Array.from(b, (x) => String.fromCharCode(x)).join("");
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function toB64(b: Uint8Array): string {
  const bin = Array.from(b, (x) => String.fromCharCode(x)).join("");
  return btoa(bin);
}

const PROTECTED_HEADER = Uint8Array.of(0xa1, 0x01, 0x27); // { 1: -8 }

function buildPermitClaimsCbor(claims: PermitClaimsV4): Uint8Array {
  const entries: Uint8Array[] = [];
  const add = (k: Uint8Array, v: Uint8Array) => { entries.push(k); entries.push(v); };

  add(cborUint(4), cborUint(claims.exp));
  add(cborUint(6), cborUint(claims.iat));
  add(cborUint(7), cborBstr(uuidToBytes(claims.permit_id)));
  add(cborNint(0), cborTstr(claims.decision_id));
  add(cborNint(1), cborBstr(uuidToBytes(claims.org_id)));
  add(cborNint(2), cborTstr(claims.action_type));
  add(cborNint(3), cborTstr(claims.actor_id));
  add(cborNint(4), cborTstr(claims.environment));
  if (claims.cdo_hash) add(cborNint(5), cborBstr(hexToBytes(claims.cdo_hash)));
  if (claims.policy_hash) add(cborNint(6), cborBstr(hexToBytes(claims.policy_hash)));

  const count = entries.length / 2;
  const mapHead = cborUint(count);
  mapHead[0]! |= 0xa0;
  return concat(mapHead, ...entries);
}

function buildSigStructure(payloadBytes: Uint8Array): Uint8Array {
  return cborArray([
    cborTstr("Signature1"),
    cborBstr(PROTECTED_HEADER),
    cborBstr(new Uint8Array(0)),
    cborBstr(payloadBytes),
  ]);
}

async function buildToken(claims: PermitClaimsV4, privateKey: CryptoKey): Promise<string> {
  const payloadBytes = buildPermitClaimsCbor(claims);
  const sigStructure = buildSigStructure(payloadBytes);
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, privateKey, sigStructure as unknown as ArrayBuffer),
  );
  const coseSign1 = concat(
    Uint8Array.of(0xd2), // CBOR tag 18
    cborArray([
      cborBstr(PROTECTED_HEADER),
      Uint8Array.of(0xa0), // empty unprotected map {}
      cborBstr(payloadBytes),
      cborBstr(sig),
    ]),
  );
  return "pt.v4." + toB64url(coseSign1);
}

// ─── Test fixtures ────────────────────────────────────────────────────────────

const TEST_CLAIMS: PermitClaimsV4 = {
  permit_id: "12345678-1234-1234-1234-123456789abc",
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000),
  decision_id: "87654321-4321-4321-4321-cba987654321",
  org_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  action_type: "production.deploy",
  actor_id: "agent:deploy-bot",
  environment: "live",
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("verifyPermitV4", () => {
  it("verifies a well-formed pt.v4.* token", async () => {
    const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
    const publicKeyB64 = toB64(rawPub);

    const token = await buildToken(TEST_CLAIMS, kp.privateKey);
    expect(token).toMatch(/^pt\.v4\./);

    const result = await verifyPermitV4(token, publicKeyB64);
    expect(result.ok).toBe(true);
    expect(result.claims.permit_id).toBe(TEST_CLAIMS.permit_id);
    expect(result.claims.action_type).toBe("production.deploy");
    expect(result.claims.actor_id).toBe("agent:deploy-bot");
    expect(result.claims.org_id).toBe(TEST_CLAIMS.org_id);
    expect(result.claims.decision_id).toBe(TEST_CLAIMS.decision_id);
    expect(result.claims.environment).toBe("live");
    expect(result.claims.exp).toBe(TEST_CLAIMS.exp);
    expect(result.claims.iat).toBe(TEST_CLAIMS.iat);
  });

  it("verifies a token with optional cdo_hash and policy_hash", async () => {
    const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));

    const claimsWithHashes: PermitClaimsV4 = {
      ...TEST_CLAIMS,
      cdo_hash: "a".repeat(64),
      policy_hash: "b".repeat(64),
    };
    const token = await buildToken(claimsWithHashes, kp.privateKey);
    const result = await verifyPermitV4(token, toB64(rawPub));
    expect(result.ok).toBe(true);
    expect(result.claims.cdo_hash).toBe("a".repeat(64));
    expect(result.claims.policy_hash).toBe("b".repeat(64));
  });

  it("verifies a test-environment token", async () => {
    const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
    const claims: PermitClaimsV4 = { ...TEST_CLAIMS, environment: "test" };
    const token = await buildToken(claims, kp.privateKey);
    const result = await verifyPermitV4(token, toB64(rawPub));
    expect(result.claims.environment).toBe("test");
  });

  it("rejects a token with a bad prefix", async () => {
    await expect(verifyPermitV4("pt.v3.abc123", "dGVzdA==")).rejects.toThrow(PermitV4VerifyError);
    await expect(verifyPermitV4("pt.v3.abc123", "dGVzdA==")).rejects.toMatchObject({ reason: "bad_prefix" });
  });

  it("rejects a non-string token", async () => {
    await expect(verifyPermitV4(null as unknown as string, "dGVzdA==")).rejects.toThrow(PermitV4VerifyError);
    await expect(verifyPermitV4(null as unknown as string, "dGVzdA==")).rejects.toMatchObject({ reason: "bad_format" });
  });

  it("rejects a token with invalid base64url payload", async () => {
    await expect(verifyPermitV4("pt.v4.!!!notbase64!!!", "dGVzdA==")).rejects.toThrow(PermitV4VerifyError);
    await expect(verifyPermitV4("pt.v4.!!!notbase64!!!", "dGVzdA==")).rejects.toMatchObject({ reason: "bad_format" });
  });

  it("rejects a token signed by a different key", async () => {
    const signingKp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const verifyKp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const verifyPub = new Uint8Array(await crypto.subtle.exportKey("raw", verifyKp.publicKey));

    const token = await buildToken(TEST_CLAIMS, signingKp.privateKey);
    await expect(verifyPermitV4(token, toB64(verifyPub))).rejects.toMatchObject({ reason: "signature_invalid" });
  });

  it("rejects a token with a tampered payload", async () => {
    const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
    const token = await buildToken(TEST_CLAIMS, kp.privateKey);

    // Flip a byte in the payload section of the COSE_Sign1.
    const coseBytes = (() => {
      const b64 = token.slice("pt.v4.".length).replace(/-/g, "+").replace(/_/g, "/");
      const bin = atob(b64 + "==".slice((b64.length + 3) % 4 === 0 ? 2 : (b64.length + 3) % 4));
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return arr;
    })();
    // Flip a byte in the middle of the payload bytes.
    coseBytes[coseBytes.length >> 1] ^= 0xff;
    const tampered = "pt.v4." + toB64url(coseBytes);

    // May throw cose_decode_failed, claims_decode_failed, or signature_invalid.
    await expect(verifyPermitV4(tampered, toB64(rawPub))).rejects.toThrow(PermitV4VerifyError);
  });

  it("accepts an unexpired token when checkExpiry: true", async () => {
    const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
    const token = await buildToken(TEST_CLAIMS, kp.privateKey);
    const result = await verifyPermitV4(token, toB64(rawPub), { checkExpiry: true });
    expect(result.ok).toBe(true);
  });

  it("rejects an expired token when checkExpiry: true", async () => {
    const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
    const expiredClaims: PermitClaimsV4 = {
      ...TEST_CLAIMS,
      exp: Math.floor(Date.now() / 1000) - 3600,
    };
    const token = await buildToken(expiredClaims, kp.privateKey);
    await expect(verifyPermitV4(token, toB64(rawPub), { checkExpiry: true }))
      .rejects.toMatchObject({ reason: "expired" });
  });

  it("accepts an expired token without checkExpiry (default)", async () => {
    const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
    const expiredClaims: PermitClaimsV4 = {
      ...TEST_CLAIMS,
      exp: Math.floor(Date.now() / 1000) - 3600,
    };
    const token = await buildToken(expiredClaims, kp.privateKey);
    const result = await verifyPermitV4(token, toB64(rawPub));
    expect(result.ok).toBe(true);
    expect(result.claims.exp).toBe(expiredClaims.exp);
  });

  it("rejects a token with wrong protected header", async () => {
    const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));

    // Build a COSE_Sign1 with a wrong protected header (e.g. { 1: -7 } = ES256).
    const wrongProtected = Uint8Array.of(0xa1, 0x01, 0x26); // { 1: -7 }
    const payloadBytes = buildPermitClaimsCbor(TEST_CLAIMS);
    const sigStructure = cborArray([
      cborTstr("Signature1"),
      cborBstr(wrongProtected),
      cborBstr(new Uint8Array(0)),
      cborBstr(payloadBytes),
    ]);
    const sig = new Uint8Array(
      await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, sigStructure as unknown as ArrayBuffer),
    );
    const coseSign1 = concat(
      Uint8Array.of(0xd2),
      cborArray([cborBstr(wrongProtected), Uint8Array.of(0xa0), cborBstr(payloadBytes), cborBstr(sig)]),
    );
    const token = "pt.v4." + toB64url(coseSign1);

    await expect(verifyPermitV4(token, toB64(rawPub))).rejects.toMatchObject({ reason: "wrong_protected_header" });
  });

  it("is exported from the package entrypoint", async () => {
    const mod = await import("../src/index.js");
    expect(typeof mod.verifyPermitV4).toBe("function");
    expect(typeof mod.PermitV4VerifyError).toBe("function");
  });
});
