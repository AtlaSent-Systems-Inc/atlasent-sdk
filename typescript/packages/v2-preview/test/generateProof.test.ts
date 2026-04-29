/**
 * Tests for the TS proof generator.
 *
 * Three flavors:
 *   1. **Round-trip**: generate a proof, then verify it via the
 *      same package's `replayProofBundle`. Closed loop, no Python.
 *   2. **Cross-language reproduction**: re-generate Python's
 *      `valid.json` fixture from inputs + same seed; assert
 *      every signature byte-equal with the on-disk fixture.
 *   3. **Sanity**: PKCS8 wrap, seed length check, chain helper.
 *
 * (1) is the customer-facing test — proves the generator's output
 * verifies. (2) is the cross-language guarantee from PR #93's flip
 * side — TS-generated proofs match Python-generated proofs given
 * identical inputs.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicKey, webcrypto } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  generateProof,
  generateProofChain,
  GENESIS_HASH,
  replayProofBundle,
  type GenerateProofInput,
  type Proof,
  type VerifyKey,
} from "../src/index.js";

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

const ACTIVE_SEED = new TextEncoder()
  .encode("ATLASENT-V2-PROOF-ACTIVE-SEED-!!")
  .slice(0, 32);

function loadFixture(name: string): { proofs: Proof[] } {
  return JSON.parse(
    readFileSync(resolve(FIXTURES_DIR, `${name}.json`), "utf8"),
  );
}

async function loadActivePublicKey(): Promise<VerifyKey> {
  const pem = readFileSync(
    resolve(FIXTURES_DIR, "signing-key.pub.pem"),
    "utf8",
  );
  const spki = createPublicKey(pem).export({ format: "der", type: "spki" });
  const cryptoKey = await webcrypto.subtle.importKey(
    "spki",
    spki,
    { name: "Ed25519" },
    true,
    ["verify"],
  );
  return { keyId: "v2-proof-key-active", publicKey: cryptoKey };
}

function inputAt(index: number, previousHash: string): GenerateProofInput {
  // Mirror the synthetic-fixture shape from
  // contract/tools/gen_proof_bundles.py::_base_proof so the byte-
  // equality test below has matching inputs.
  const indexHex = index.toString(16).padStart(2, "0");
  return {
    proof_id: `proof-${indexHex}-0000-0000-0000-000000000000`.slice(0, 36),
    permit_id: `dec_${index.toString(16).padStart(4, "0")}`,
    org_id: "org-v2-proof-fixture",
    agent: "fixture-agent",
    action: "fixture.action",
    target: `target-${index}`,
    payload_hash: indexHex.repeat(32),
    policy_version: "policy-v2-fixture-1",
    decision: "allow",
    execution_status: "executed",
    execution_hash: null,
    audit_hash: ((index + 0x80) % 256).toString(16).padStart(2, "0").repeat(32),
    previous_hash: previousHash,
    chain_hash: ((index + 0xc0) % 256).toString(16).padStart(2, "0").repeat(32),
    signing_key_id: "v2-proof-key-active",
    issued_at: `2026-04-24T12:${index.toString().padStart(2, "0")}:00Z`,
    consumed_at: `2026-04-24T12:${index.toString().padStart(2, "0")}:01Z`,
  };
}

// ── Round-trip ──────────────────────────────────────────────────────


describe("generateProof — round-trip", () => {
  it("produces a Proof that the replay harness verifies", async () => {
    const proof = await generateProof(inputAt(0, GENESIS_HASH), {
      seed: ACTIVE_SEED,
    });
    expect(proof.signature).toMatch(/^[A-Za-z0-9_-]+$/);

    const active = await loadActivePublicKey();
    const result = await replayProofBundle([proof], { keys: [active] });
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.proofs[0]?.verification_status).toBe("valid");
  });
});

// ── Cross-language reproduction (Python's fixture, regenerated in TS) ──


describe("generateProof — reproduces Python's valid.json byte-for-byte", () => {
  it("re-signs all 3 proofs with byte-equal signatures", async () => {
    const fixture = loadFixture("valid");
    expect(fixture.proofs).toHaveLength(3);

    let prev = GENESIS_HASH;
    for (let i = 0; i < fixture.proofs.length; i += 1) {
      const ourProof = await generateProof(inputAt(i, prev), {
        seed: ACTIVE_SEED,
      });
      const theirProof = fixture.proofs[i]!;
      expect(
        ourProof.signature,
        `proofs[${i}] signature mismatch — TS generator drift`,
      ).toBe(theirProof.signature);
      // Sanity: every other field is identical too.
      expect(ourProof.proof_id).toBe(theirProof.proof_id);
      expect(ourProof.previous_hash).toBe(theirProof.previous_hash);
      expect(ourProof.chain_hash).toBe(theirProof.chain_hash);
      prev = theirProof.chain_hash;
    }
  });
});

// ── generateProofChain ──────────────────────────────────────────────


describe("generateProofChain", () => {
  it("threads previous_hash across the chain", async () => {
    const inputs = [0, 1, 2].map((i) =>
      // Strip previous_hash — the chain helper provides it.
      Object.fromEntries(
        Object.entries(inputAt(i, GENESIS_HASH)).filter(
          ([k]) => k !== "previous_hash",
        ),
      ) as Omit<GenerateProofInput, "previous_hash">,
    );

    const chain = await generateProofChain(inputs, { seed: ACTIVE_SEED });
    expect(chain).toHaveLength(3);
    expect(chain[0]?.previous_hash).toBe(GENESIS_HASH);
    expect(chain[1]?.previous_hash).toBe(chain[0]?.chain_hash);
    expect(chain[2]?.previous_hash).toBe(chain[1]?.chain_hash);
  });

  it("produces signatures byte-equal to Python's valid.json", async () => {
    const inputs = [0, 1, 2].map((i) =>
      Object.fromEntries(
        Object.entries(inputAt(i, GENESIS_HASH)).filter(
          ([k]) => k !== "previous_hash",
        ),
      ) as Omit<GenerateProofInput, "previous_hash">,
    );

    const chain = await generateProofChain(inputs, { seed: ACTIVE_SEED });
    const fixture = loadFixture("valid");
    for (let i = 0; i < chain.length; i += 1) {
      expect(chain[i]?.signature, `chain[${i}]`).toBe(
        fixture.proofs[i]?.signature,
      );
    }
  });

  it("returns an empty array for empty inputs", async () => {
    const chain = await generateProofChain([], { seed: ACTIVE_SEED });
    expect(chain).toEqual([]);
  });
});

// ── Validation ─────────────────────────────────────────────────────


describe("generateProof — validation", () => {
  it("rejects a non-32-byte seed", async () => {
    await expect(
      generateProof(inputAt(0, GENESIS_HASH), {
        seed: new Uint8Array(31),
      }),
    ).rejects.toThrow(/32 bytes/i);
  });

  it("rejects a 0-byte seed", async () => {
    await expect(
      generateProof(inputAt(0, GENESIS_HASH), {
        seed: new Uint8Array(0),
      }),
    ).rejects.toThrow(/32 bytes/i);
  });

  it("accepts a 32-byte seed", async () => {
    const proof = await generateProof(inputAt(0, GENESIS_HASH), {
      seed: ACTIVE_SEED,
    });
    expect(proof.signature.length).toBeGreaterThan(0);
  });

  it("preserves all caller-provided fields verbatim in the output", async () => {
    const input = inputAt(7, "ff".repeat(32));
    const proof = await generateProof(input, { seed: ACTIVE_SEED });
    // Every field from the input survives unchanged on the output.
    for (const key of Object.keys(input) as Array<keyof typeof input>) {
      expect(proof[key as keyof Proof]).toEqual(input[key]);
    }
  });
});
