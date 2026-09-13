/**
 * ADR-005 revocation must be anchored to the key that ACTUALLY verified the
 * signature, not to the bundle's unsigned `signing_key_id` hint.
 *
 * Regression for the Codex P1 on atlasent-sdk#519: with both a revoked key
 * and its successor loaded (the normal state during a rotation window), a
 * bundle signed by the revoked key but advertising the successor's kid used
 * to verify — the revocation check only ever looked at the hint.
 *
 * Test names mirror python/tests/test_audit_bundle_revocation_material.py.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  rawEd25519FromSpki,
  signedBytesFor,
  verifyAuditBundle,
  type AuditBundle,
  type VerifyKey,
} from "../src/auditBundle.js";
import { BundleVerificationError } from "../src/errors.js";
import type { TrustRootSnapshot } from "../src/trustRoot.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES = resolve(HERE, "..", "..", "contract", "vectors", "audit-bundles");
const { subtle } = webcrypto;

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

interface Signer {
  keyId: string;
  x: string;
  privateKey: webcrypto.CryptoKey;
  /** With raw material (what `publicKeysPem` loading produces). */
  verifyKey: VerifyKey;
  /** Without raw material (a caller-constructed VerifyKey, pre-2026-09-13 shape). */
  bareKey: VerifyKey;
}

async function signer(keyId: string): Promise<Signer> {
  const kp = (await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as unknown as webcrypto.CryptoKeyPair;
  const spki = new Uint8Array(await subtle.exportKey("spki", kp.publicKey));
  const raw = rawEd25519FromSpki(spki);
  if (!raw) throw new Error("unexpected SPKI shape");
  const publicKey = await subtle.importKey("spki", spki, { name: "Ed25519" }, false, ["verify"]);
  return {
    keyId,
    x: b64url(raw),
    privateKey: kp.privateKey,
    verifyKey: { keyId, publicKey, publicKeyRaw: raw },
    bareKey: { keyId, publicKey },
  };
}

function baseBundle(): AuditBundle {
  const raw = JSON.parse(readFileSync(resolve(FIXTURES, "valid.json"), "utf8"));
  return (raw.bundle ?? raw) as AuditBundle;
}

async function signedBy(s: Signer, advertisedKid: string): Promise<AuditBundle> {
  const b = { ...baseBundle(), signing_key_id: advertisedKid } as AuditBundle & { signature?: string };
  delete b.signature;
  const sig = new Uint8Array(await subtle.sign("Ed25519", s.privateKey, signedBytesFor(b)));
  return { ...b, signature: b64url(sig) } as AuditBundle;
}

function snapshot(live: Signer, revoked: Signer, permit: Signer): TrustRootSnapshot {
  const entry = (s: Signer, kid: string, role: "R3_audit" | "R2_permit", isRevoked: boolean) => ({
    kid, role, kty: "OKP", crv: "Ed25519", alg: "EdDSA", x: s.x,
    valid_from: null, valid_until: null, replaced_by: null, revoked: isRevoked, tenant: null,
  });
  return {
    valid_until: "2099-01-01T00:00:00Z",
    issued_at: "2026-01-01T00:00:00Z",
    keys: [
      entry(live, "v1", "R3_audit", false),
      entry(revoked, "v2-old", "R3_audit", true),
      entry(permit, "permit-kid", "R2_permit", false),
    ],
    revoked_keys: [{ kid: "v2-old", role: "R3_audit", revoked_at: "2026-09-12T21:06:42Z", reason: "rotated out" }],
    revoked_identities: [],
  };
}

describe("revocation is checked against the key that verified, not the advertised kid", () => {
  it("bundle signed by the revoked key but advertising the live kid → key_revoked (the P1)", async () => {
    const [live, revoked, permit] = await Promise.all([signer("live"), signer("revoked"), signer("permit")]);
    const bundle = await signedBy(revoked, "v1");
    const trustRoot = snapshot(live, revoked, permit);
    for (const keys of [[revoked.verifyKey, live.verifyKey], [live.verifyKey, revoked.verifyKey]]) {
      await expect(verifyAuditBundle(bundle, keys, { trustRoot })).rejects.toMatchObject({
        reason: "key_revoked",
        kid: "v2-old",
      });
      await expect(verifyAuditBundle(bundle, keys, { trustRoot })).rejects.toBeInstanceOf(BundleVerificationError);
    }
  });

  it("bundle signed by the live key advertising the live kid → verified", async () => {
    const [live, revoked, permit] = await Promise.all([signer("live"), signer("revoked"), signer("permit")]);
    const bundle = await signedBy(live, "v1");
    const r = await verifyAuditBundle(bundle, [revoked.verifyKey, live.verifyKey], {
      trustRoot: snapshot(live, revoked, permit),
    });
    expect(r.signatureValid).toBe(true);
    expect(r.matchedKeyId).toBe("live");
    expect(r.verified).toBe(true);
  });

  it("bundle signed by a permit-role key advertising the audit kid → key_role_mismatch on the real key", async () => {
    const [live, revoked, permit] = await Promise.all([signer("live"), signer("revoked"), signer("permit")]);
    const bundle = await signedBy(permit, "v1");
    await expect(
      verifyAuditBundle(bundle, [live.verifyKey, permit.verifyKey], { trustRoot: snapshot(live, revoked, permit) }),
    ).rejects.toMatchObject({ reason: "key_role_mismatch", kid: "permit-kid" });
  });

  it("a bundle that merely advertises a revoked kid still fails, even when signed by the live key (fail-closed)", async () => {
    const [live, revoked, permit] = await Promise.all([signer("live"), signer("revoked"), signer("permit")]);
    const bundle = await signedBy(live, "v2-old");
    await expect(
      verifyAuditBundle(bundle, [live.verifyKey], { trustRoot: snapshot(live, revoked, permit) }),
    ).rejects.toMatchObject({ reason: "key_revoked", kid: "v2-old" });
  });

  it("keys supplied without raw material fall back to the hint-only check — a documented limit, pinned", async () => {
    // A caller constructing VerifyKey by hand (no publicKeyRaw) gets the
    // pre-fix semantics: the verifier cannot tell which trust-root entry the
    // key is, so only the advertised kid is checked. Load keys via
    // `publicKeysPem` (or `verifyKeyFromSpkiPem`) to get material matching.
    const [live, revoked, permit] = await Promise.all([signer("live"), signer("revoked"), signer("permit")]);
    const bundle = await signedBy(revoked, "v1");
    const r = await verifyAuditBundle(bundle, [revoked.bareKey, live.bareKey], {
      trustRoot: snapshot(live, revoked, permit),
    });
    expect(r.signatureValid).toBe(true);
  });
});
