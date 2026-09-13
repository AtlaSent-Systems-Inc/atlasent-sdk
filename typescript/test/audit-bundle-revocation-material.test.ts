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
  /** Without raw material, non-extractable (a caller-constructed VerifyKey, pre-2026-09-13 shape). */
  bareKey: VerifyKey;
  /** Without raw material but extractable, so the verifier can derive it. */
  bareExtractableKey: VerifyKey;
}

async function signer(keyId: string): Promise<Signer> {
  const kp = (await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as unknown as webcrypto.CryptoKeyPair;
  const spki = new Uint8Array(await subtle.exportKey("spki", kp.publicKey));
  const raw = rawEd25519FromSpki(spki);
  if (!raw) throw new Error("unexpected SPKI shape");
  const publicKey = await subtle.importKey("spki", spki, { name: "Ed25519" }, false, ["verify"]);
  const extractable = await subtle.importKey("spki", spki, { name: "Ed25519" }, true, ["verify"]);
  return {
    keyId,
    x: b64url(raw),
    privateKey: kp.privateKey,
    verifyKey: { keyId, publicKey, publicKeyRaw: raw },
    bareKey: { keyId, publicKey },
    bareExtractableKey: { keyId, publicKey: extractable },
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

/** The revoked material re-published under a second, LIVE kid ("v3-alias"). */
function snapshotWithAlias(live: Signer, revoked: Signer, permit: Signer, ledgerEntry: boolean): TrustRootSnapshot {
  const snap = snapshot(live, revoked, permit);
  snap.keys.push({
    kid: "v3-alias", role: "R3_audit", kty: "OKP", crv: "Ed25519", alg: "EdDSA", x: revoked.x,
    valid_from: null, valid_until: null, replaced_by: null, revoked: false, tenant: null,
  });
  if (!ledgerEntry) snap.revoked_keys = [];
  return snap;
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

  it("keys without raw material have it derived — a revoked signer advertising a live kid still fails (bypass 1)", async () => {
    // Review on atlasent-sdk#519: a caller-constructed VerifyKey with no
    // publicKeyRaw used to fall back to the unsigned hint. Now the material is
    // exported from the CryptoKey and the revocation lands on the real signer.
    const [live, revoked, permit] = await Promise.all([signer("live"), signer("revoked"), signer("permit")]);
    const bundle = await signedBy(revoked, "v1");
    const trustRoot = snapshot(live, revoked, permit);
    for (const keys of [
      [revoked.bareExtractableKey, live.bareExtractableKey],
      [live.bareExtractableKey, revoked.bareExtractableKey],
    ]) {
      await expect(verifyAuditBundle(bundle, keys, { trustRoot })).rejects.toMatchObject({
        reason: "key_revoked",
        kid: "v2-old",
      });
    }
  });

  it("a non-extractable key with no raw material fails closed with key_material_unavailable, never on the hint", async () => {
    const [live, revoked, permit] = await Promise.all([signer("live"), signer("revoked"), signer("permit")]);
    const trustRoot = snapshot(live, revoked, permit);
    // Even a bundle genuinely signed by the LIVE key is refused: with a trust
    // root present the verifier will not vouch for a key it cannot anchor.
    for (const bundle of [await signedBy(revoked, "v1"), await signedBy(live, "v1")]) {
      await expect(verifyAuditBundle(bundle, [revoked.bareKey, live.bareKey], { trustRoot })).rejects.toMatchObject({
        reason: "key_material_unavailable",
      });
    }
    // Without a trust root the material is not needed and the signature check stands on its own.
    const r = await verifyAuditBundle(await signedBy(live, "v1"), [live.bareKey]);
    expect(r.signatureValid).toBe(true);
  });

  it.each([true, false])(
    "shared material under a live alias kid is still revoked, ledger entry present=%s (bypass 2)",
    async (ledgerEntry) => {
      // Review on atlasent-sdk#519: the hint used to narrow verifyingEntries
      // to the attacker-selected live alias. Every entry sharing the material
      // is now judged — including one revoked only by its own `revoked` flag.
      const [live, revoked, permit] = await Promise.all([signer("live"), signer("revoked"), signer("permit")]);
      const trustRoot = snapshotWithAlias(live, revoked, permit, ledgerEntry);
      const bundle = await signedBy(revoked, "v3-alias");
      for (const keys of [[revoked.verifyKey, live.verifyKey], [revoked.bareExtractableKey, live.bareExtractableKey]]) {
        await expect(verifyAuditBundle(bundle, keys, { trustRoot })).rejects.toMatchObject({
          reason: "key_revoked",
          kid: "v2-old",
        });
      }
    },
  );

  it("a live key still verifies when an unrelated alias entry exists", async () => {
    const [live, revoked, permit] = await Promise.all([signer("live"), signer("revoked"), signer("permit")]);
    const trustRoot = snapshotWithAlias(live, revoked, permit, true);
    const r = await verifyAuditBundle(await signedBy(live, "v1"), [live.verifyKey], { trustRoot });
    expect(r.verified).toBe(true);
  });
});

describe("caller-supplied publicKeyRaw can never select a different trust-root entry (round 3)", () => {
  // Review on atlasent-sdk#519, round 3: `matchedKeyRaw = k.publicKeyRaw` was
  // trusted whenever present, so a VerifyKey whose metadata carried the LIVE
  // key's bytes while its CryptoKey was the REVOKED key was judged by the live
  // material. The material must come from the key that verified.

  it("extractable revoked CryptoKey + live publicKeyRaw metadata → key_revoked (material exported, metadata ignored)", async () => {
    const [live, revoked, permit] = await Promise.all([signer("live"), signer("revoked"), signer("permit")]);
    const trustRoot = snapshot(live, revoked, permit);
    const lying: VerifyKey = { ...revoked.bareExtractableKey, publicKeyRaw: live.verifyKey.publicKeyRaw as Uint8Array };
    const bundle = await signedBy(revoked, "v1");
    await expect(verifyAuditBundle(bundle, [lying], { trustRoot })).rejects.toMatchObject({
      reason: "key_revoked",
      kid: "v2-old",
    });
  });

  it("non-extractable revoked CryptoKey + live publicKeyRaw metadata → key_material_unavailable (metadata fails re-verification)", async () => {
    const [live, revoked, permit] = await Promise.all([signer("live"), signer("revoked"), signer("permit")]);
    const trustRoot = snapshot(live, revoked, permit);
    const lying: VerifyKey = { ...revoked.bareKey, publicKeyRaw: live.verifyKey.publicKeyRaw as Uint8Array };
    const bundle = await signedBy(revoked, "v1");
    // Not `verified`, and not judged as the live key either: the only bytes on
    // offer do not verify the signature, so no material is established.
    await expect(verifyAuditBundle(bundle, [lying], { trustRoot })).rejects.toMatchObject({
      reason: "key_material_unavailable",
    });
  });

  it("non-extractable live CryptoKey + its own publicKeyRaw → verified (re-verified bytes are accepted)", async () => {
    const [live, revoked, permit] = await Promise.all([signer("live"), signer("revoked"), signer("permit")]);
    const trustRoot = snapshot(live, revoked, permit);
    const r = await verifyAuditBundle(await signedBy(live, "v1"), [live.verifyKey], { trustRoot });
    expect(r.verified).toBe(true);
    expect(r.matchedKeyId).toBe("live");
  });

  it("non-extractable revoked CryptoKey + its own publicKeyRaw → key_revoked (re-verified bytes anchor the real signer)", async () => {
    const [live, revoked, permit] = await Promise.all([signer("live"), signer("revoked"), signer("permit")]);
    const trustRoot = snapshot(live, revoked, permit);
    await expect(
      verifyAuditBundle(await signedBy(revoked, "v1"), [revoked.verifyKey, live.verifyKey], { trustRoot }),
    ).rejects.toMatchObject({ reason: "key_revoked", kid: "v2-old" });
  });

  it("verifyKeyFromSpkiPem is exported from the package entry point and yields an extractable key", async () => {
    const sdk = await import("../src/index.js");
    expect(typeof sdk.verifyKeyFromSpkiPem).toBe("function");
    expect(typeof sdk.rawEd25519FromSpki).toBe("function");
    const [live, revoked, permit] = await Promise.all([signer("live"), signer("revoked"), signer("permit")]);
    const spki = new Uint8Array(await subtle.exportKey("spki", live.bareExtractableKey.publicKey));
    const pem = `-----BEGIN PUBLIC KEY-----\n${Buffer.from(spki).toString("base64")}\n-----END PUBLIC KEY-----\n`;
    const key = await sdk.verifyKeyFromSpkiPem(pem, "live");
    expect(key.publicKey.extractable).toBe(true);
    expect(key.publicKeyRaw && b64url(key.publicKeyRaw)).toBe(live.x);
    const r = await verifyAuditBundle(await signedBy(live, "v1"), [key], { trustRoot: snapshot(live, revoked, permit) });
    expect(r.verified).toBe(true);
  });
});
