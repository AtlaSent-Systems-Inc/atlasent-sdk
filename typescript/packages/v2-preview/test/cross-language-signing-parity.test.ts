/**
 * Cross-language signing-parity test.
 *
 * Proves that TypeScript and Python produce byte-identical Ed25519
 * signatures for the same proof + same seed, so a proof signed by
 * one preview SDK verifies under the other and vice versa. This is
 * the strongest possible parity assertion for the 16-field signed
 * envelope convention codified in three places:
 *
 *   * contract/tools/gen_proof_bundles.py::SIGNED_FIELDS
 *   * src/verifyProof.ts::SIGNED_ENVELOPE_FIELDS
 *   * python/atlasent_v2_preview/.../verify_proof.py::SIGNED_ENVELOPE_FIELDS
 *
 * Mechanism:
 *   1. Load the on-disk fixture (signed by the Python generator
 *      with a fixed Ed25519 seed in `gen_proof_bundles.py`).
 *   2. Reconstruct the signed envelope on the TS side using
 *      `signedBytesForProof`.
 *   3. Sign with the same seed via Node webcrypto.
 *   4. Assert byte-equal signatures.
 *
 * Ed25519 is deterministic per RFC 8032 — given the same seed and
 * the same message, the signature is uniquely determined. So any
 * mismatch in canonicalization OR in the signed-envelope field
 * subset would fire here.
 *
 * This test covers the case the consumer test in
 * `fixtures.test.ts` doesn't: that test only verifies the
 * Python-signed fixtures with the TS verifier (uses the public
 * key). This test exercises the full signing path with the
 * private key.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { Proof } from "../src/types.js";
import { signedBytesForProof } from "../src/verifyProof.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "contract",
  "vectors",
  "v2",
  "proof-bundles",
);

// Match the seeds defined in `contract/tools/gen_proof_bundles.py`.
// 32 raw bytes, public + test-only.
const ACTIVE_SEED = new TextEncoder().encode(
  "ATLASENT-V2-PROOF-ACTIVE-SEED-!!",
).slice(0, 32);
const OTHER_SEED = new TextEncoder().encode(
  "ATLASENT-V2-PROOF-OTHER-SEED-!!!",
).slice(0, 32);

/**
 * Wrap a 32-byte Ed25519 seed in PKCS8 DER so webcrypto can import
 * it. The DER prefix is fixed for all Ed25519 PKCS8 keys; only the
 * 32-byte seed varies.
 *
 *   30 2e             SEQUENCE (46 bytes)
 *     02 01 00       version=0
 *     30 05         SEQUENCE algorithm
 *       06 03 2b 65 70    OID 1.3.101.112 (Ed25519)
 *     04 22         OCTET STRING (34 bytes)
 *       04 20 [32 seed bytes]
 */
const PKCS8_ED25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
  0x04, 0x22, 0x04, 0x20,
]);

function pkcs8FromSeed(seed: Uint8Array): Uint8Array {
  if (seed.length !== 32) {
    throw new Error(`Ed25519 seed must be 32 bytes, got ${seed.length}`);
  }
  const out = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
  out.set(PKCS8_ED25519_PREFIX, 0);
  out.set(seed, PKCS8_ED25519_PREFIX.length);
  return out;
}

async function privateKeyFromSeed(seed: Uint8Array): Promise<webcrypto.CryptoKey> {
  const pkcs8 = pkcs8FromSeed(seed);
  return webcrypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function signProof(
  privateKey: webcrypto.CryptoKey,
  proof: Proof,
): Promise<string> {
  const bytes = signedBytesForProof(proof);
  const sig = await webcrypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    bytes,
  );
  return base64UrlEncode(new Uint8Array(sig));
}

function loadFixture(name: string): {
  proofs: Proof[];
} {
  const raw = readFileSync(resolve(FIXTURES_DIR, `${name}.json`), "utf8");
  return JSON.parse(raw);
}

// ── Tests ───────────────────────────────────────────────────────────


describe("cross-language signing parity", () => {
  it("seed bytes match the Python generator's _ACTIVE_SEED", () => {
    // Sanity: 32 raw bytes, ASCII-only, matches the Python literal.
    expect(ACTIVE_SEED.length).toBe(32);
    expect(new TextDecoder().decode(ACTIVE_SEED)).toBe(
      "ATLASENT-V2-PROOF-ACTIVE-SEED-!!",
    );
    expect(OTHER_SEED.length).toBe(32);
    expect(new TextDecoder().decode(OTHER_SEED)).toBe(
      "ATLASENT-V2-PROOF-OTHER-SEED-!!!",
    );
  });

  it("PKCS8-imported Ed25519 key produces a valid private key", async () => {
    const key = await privateKeyFromSeed(ACTIVE_SEED);
    expect(key.algorithm.name).toBe("Ed25519");
    expect(key.type).toBe("private");
    expect(key.usages).toContain("sign");
  });

  it("re-signs valid.json with the same seed and matches Python's signatures", async () => {
    const fixture = loadFixture("valid");
    const privateKey = await privateKeyFromSeed(ACTIVE_SEED);

    for (const [i, proof] of fixture.proofs.entries()) {
      const ourSig = await signProof(privateKey, proof);
      expect(
        ourSig,
        `proofs[${i}] signature mismatch — TS canonicalization, ` +
          `Ed25519 deterministic-signing, or 16-field envelope drift`,
      ).toBe(proof.signature);
    }
  });

  it("re-signs broken-chain.json (Python re-signed after mutation)", async () => {
    const fixture = loadFixture("broken-chain");
    const privateKey = await privateKeyFromSeed(ACTIVE_SEED);

    // The fixture has proof[1] mutated and re-signed by Python's
    // generator. TS reproducing the same signature confirms our
    // signedBytesForProof catches the mutated previous_hash.
    for (const [i, proof] of fixture.proofs.entries()) {
      const ourSig = await signProof(privateKey, proof);
      expect(ourSig, `broken-chain proofs[${i}]`).toBe(proof.signature);
    }
  });

  it("re-signs pending.json (one proof has execution_status=pending)", async () => {
    const fixture = loadFixture("pending");
    const privateKey = await privateKeyFromSeed(ACTIVE_SEED);

    for (const [i, proof] of fixture.proofs.entries()) {
      const ourSig = await signProof(privateKey, proof);
      expect(ourSig, `pending proofs[${i}]`).toBe(proof.signature);
    }
  });

  it("re-signs rotated-key.json (signed by active, advertises retired)", async () => {
    const fixture = loadFixture("rotated-key");
    const privateKey = await privateKeyFromSeed(ACTIVE_SEED);

    for (const [i, proof] of fixture.proofs.entries()) {
      const ourSig = await signProof(privateKey, proof);
      expect(ourSig, `rotated-key proofs[${i}]`).toBe(proof.signature);
    }
  });

  it("re-signs wrong-key.json with the OTHER seed and matches", async () => {
    const fixture = loadFixture("wrong-key");
    const otherKey = await privateKeyFromSeed(OTHER_SEED);

    // The fixture is signed by the OTHER key — re-signing with the
    // active key would NOT match. Confirms the OTHER seed produces
    // the same signatures Python does.
    for (const [i, proof] of fixture.proofs.entries()) {
      const ourSig = await signProof(otherKey, proof);
      expect(ourSig, `wrong-key proofs[${i}]`).toBe(proof.signature);
    }
  });

  it("re-signs tampered-payload.json (sig invalid — but still byte-deterministic)", async () => {
    // The tampered fixture has proof[1].payload_hash mutated AFTER
    // signing — the on-disk signature is the original, valid sig
    // for the un-mutated envelope. So re-signing the MUTATED proof
    // with the active key gives a DIFFERENT signature than what's
    // on disk. Both proofs[0] and proofs[2] (untampered) match.
    const fixture = loadFixture("tampered-payload");
    const privateKey = await privateKeyFromSeed(ACTIVE_SEED);

    for (const [i, proof] of fixture.proofs.entries()) {
      const ourSig = await signProof(privateKey, proof);
      if (i === 1) {
        // Tampered envelope produces a different signature than the
        // on-disk one — confirms the tamper detection works.
        expect(ourSig).not.toBe(proof.signature);
      } else {
        expect(ourSig).toBe(proof.signature);
      }
    }
  });
});
