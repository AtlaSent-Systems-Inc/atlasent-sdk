/**
 * Cross-language parity test — TS side.
 *
 * Reads the shared proof-bundle vectors at
 * ``contract/vectors/v2/proof-bundles/`` and runs each through the
 * v2-preview replay harness, asserting the verdict matches the
 * fixture's ``expected`` block.
 *
 * The Python sibling
 * (``python/atlasent_v2_preview/tests/test_fixtures.py``) consumes
 * the same fixtures with the same assertions. Any drift between
 * languages, between SDKs and the generator, or between SDKs and the
 * schemas surfaces here at CI time.
 */

import { readFileSync } from "node:fs";
import { createPublicKey, webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { Proof } from "../src/types.js";
import { replayProofBundle, type VerifyKey } from "../src/verifyProof.js";

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

interface FixtureBundle {
  description: string;
  expected: Record<string, unknown>;
  proofs: Proof[];
}

function loadFixture(name: string): FixtureBundle {
  const raw = readFileSync(resolve(FIXTURES_DIR, `${name}.json`), "utf8");
  return JSON.parse(raw) as FixtureBundle;
}

async function loadVerifyKey(
  filename: string,
  keyId: string,
): Promise<VerifyKey> {
  const pem = readFileSync(resolve(FIXTURES_DIR, filename), "utf8");
  // Bridge node:crypto KeyObject → webcrypto.CryptoKey via SPKI DER
  // round-trip. Node 20 imports Ed25519 SPKI directly into webcrypto.
  const spki = createPublicKey(pem).export({ format: "der", type: "spki" });
  const cryptoKey = await webcrypto.subtle.importKey(
    "spki",
    spki,
    { name: "Ed25519" },
    true,
    ["verify"],
  );
  return { keyId, publicKey: cryptoKey };
}

describe("contract/vectors/v2/proof-bundles fixtures", () => {
  it("valid.json: every proof passes under the active key", async () => {
    const active = await loadVerifyKey("signing-key.pub.pem", "v2-proof-key-active");
    const fx = loadFixture("valid");
    const result = await replayProofBundle(fx.proofs, { keys: [active] });
    expect({
      passed: result.passed,
      failed: result.failed,
      incomplete: result.incomplete,
    }).toEqual(fx.expected);
  });

  it("tampered-payload.json: signature fails at the tampered index", async () => {
    const active = await loadVerifyKey("signing-key.pub.pem", "v2-proof-key-active");
    const fx = loadFixture("tampered-payload");
    const result = await replayProofBundle(fx.proofs, { keys: [active] });
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.proofs[1]!.verification_status).toBe("invalid");
    const sig = result.proofs[1]!.checks.find((c) => c.name === "signature");
    expect(sig?.passed).toBe(false);
    expect(sig?.reason).toBe("invalid_signature");
  });

  it("broken-chain.json: chain_link fails at the re-pointed index, signature still valid", async () => {
    const active = await loadVerifyKey("signing-key.pub.pem", "v2-proof-key-active");
    const fx = loadFixture("broken-chain");
    const result = await replayProofBundle(fx.proofs, { keys: [active] });
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(1);
    const link = result.proofs[1]!.checks.find((c) => c.name === "chain_link");
    expect(link?.passed).toBe(false);
    expect(link?.reason).toBe("broken_chain");
    // Signature on the same proof should still pass — sig was recomputed
    // over the mutated envelope by the generator.
    const sig = result.proofs[1]!.checks.find((c) => c.name === "signature");
    expect(sig?.passed).toBe(true);
  });

  it("pending.json: non-strict reports incomplete; strict reports invalid", async () => {
    const active = await loadVerifyKey("signing-key.pub.pem", "v2-proof-key-active");
    const fx = loadFixture("pending");

    const nonStrict = await replayProofBundle(fx.proofs, { keys: [active] });
    expect({
      passed: nonStrict.passed,
      failed: nonStrict.failed,
      incomplete: nonStrict.incomplete,
    }).toEqual({ passed: 2, failed: 0, incomplete: 1 });
    expect(nonStrict.proofs[1]!.verification_status).toBe("incomplete");

    const strict = await replayProofBundle(fx.proofs, {
      keys: [active],
      strict: true,
    });
    expect({
      passed: strict.passed,
      failed: strict.failed,
      incomplete: strict.incomplete,
    }).toEqual({ passed: 2, failed: 1, incomplete: 0 });
    const exec = strict.proofs[1]!.checks.find(
      (c) => c.name === "execution_coherence",
    );
    expect(exec?.reason).toBe("execution_not_consumed");
  });

  it("wrong-key.json under the active key: every signature fails", async () => {
    const active = await loadVerifyKey("signing-key.pub.pem", "v2-proof-key-active");
    const fx = loadFixture("wrong-key");
    const result = await replayProofBundle(fx.proofs, { keys: [active] });
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(3);
    for (const entry of result.proofs) {
      const sig = entry.checks.find((c) => c.name === "signature");
      expect(sig?.reason).toBe("invalid_signature");
    }
  });

  it("wrong-key.json under the OTHER key: rotation fallback succeeds", async () => {
    // The bundle advertises signing_key_id="v2-proof-key-active" but
    // was actually signed by the OTHER key. Verifying with only the
    // OTHER key in the trust set: hint doesn't match anything in the
    // keyset, so the verifier falls through to "any other key" — and
    // the OTHER key is exactly that. Demonstrates rotation semantics.
    const other = await loadVerifyKey("other-key.pub.pem", "v2-proof-key-other");
    const fx = loadFixture("wrong-key");
    const result = await replayProofBundle(fx.proofs, { keys: [other] });
    expect(result.passed).toBe(3);
    expect(result.failed).toBe(0);
  });

  it("rotated-key.json with active key: rotation fallback succeeds", async () => {
    const active = await loadVerifyKey("signing-key.pub.pem", "v2-proof-key-active");
    const fx = loadFixture("rotated-key");
    const result = await replayProofBundle(fx.proofs, { keys: [active] });
    expect(result.passed).toBe(3);
    expect(result.failed).toBe(0);
    // Each proof's signature check matched the active key, even though
    // the bundle advertises signing_key_id="v2-proof-key-retired".
    for (const entry of result.proofs) {
      expect(entry.signing_key_id).toBe("v2-proof-key-active");
    }
  });

  it("rotated-key.json with only the OTHER key: retired_signing_key surfaces", async () => {
    // No key in the trust set matches the proofs' actual signature, AND
    // the advertised retired key id isn't in the trust set either. The
    // verifier reports retired_signing_key (vs. invalid_signature) so
    // operators can distinguish "I rotated the key" from "the bundle
    // is forged".
    const other = await loadVerifyKey("other-key.pub.pem", "v2-proof-key-other");
    const fx = loadFixture("rotated-key");
    const result = await replayProofBundle(fx.proofs, { keys: [other] });
    expect(result.failed).toBe(3);
    for (const entry of result.proofs) {
      const sig = entry.checks.find((c) => c.name === "signature");
      expect(sig?.reason).toBe("retired_signing_key");
    }
  });
});
