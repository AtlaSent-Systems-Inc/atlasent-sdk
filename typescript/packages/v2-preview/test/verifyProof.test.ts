/**
 * Offline replay harness tests.
 *
 * Strategy: generate synthetic Ed25519 key pairs at test time, hand-
 * build Proof objects, sign them with the test key, then run them
 * through `replayProofBundle` / `verifyProof`. No network, no
 * fixtures on disk — the whole lifecycle is exercised against the
 * actual `webcrypto` primitives the runtime will use.
 *
 * Covers: valid single proof, valid multi-proof chain, tampered
 * payload hash, broken chain link, wrong key, rotated key (hint
 * misses, fallback succeeds), pending execution (strict + non-strict),
 * absent signature, malformed base64url signature, empty key set,
 * out-of-order bundles.
 */

import { webcrypto } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { canonicalizePayload } from "../src/canonicalize.js";
import type { Proof } from "../src/types.js";
import {
  replayProofBundle,
  signedBytesForProof,
  verifyProof,
  type VerifyKey,
} from "../src/verifyProof.js";

const GENESIS = "0".repeat(64);

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function genKey(
  keyId: string,
): Promise<{ verifyKey: VerifyKey; privateKey: webcrypto.CryptoKey }> {
  const pair = (await webcrypto.subtle.generateKey(
    { name: "Ed25519" } as webcrypto.AlgorithmIdentifier,
    true,
    ["sign", "verify"],
  )) as webcrypto.CryptoKeyPair;
  return {
    verifyKey: { keyId, publicKey: pair.publicKey },
    privateKey: pair.privateKey,
  };
}

async function signProof(
  privateKey: webcrypto.CryptoKey,
  proof: Omit<Proof, "signature">,
): Promise<string> {
  const bytes = signedBytesForProof({ ...proof, signature: "" } as Proof);
  const sig = new Uint8Array(
    await webcrypto.subtle.sign({ name: "Ed25519" }, privateKey, bytes),
  );
  return base64UrlEncode(sig);
}

function baseProof(
  overrides: Partial<Proof> = {},
): Omit<Proof, "signature"> & { signature: string } {
  return {
    proof_id: "11111111-2222-3333-4444-555555555555",
    permit_id: "dec_abc",
    org_id: "org-1",
    agent: "deploy-bot",
    action: "deploy_to_production",
    target: "prod-cluster",
    payload_hash: "a".repeat(64),
    policy_version: "v3-a7f1",
    decision: "allow",
    execution_status: "executed",
    execution_hash: null,
    audit_hash: "b".repeat(64),
    previous_hash: GENESIS,
    chain_hash: "c".repeat(64),
    signing_key_id: "key-test",
    signature: "",
    issued_at: "2026-04-24T12:00:00Z",
    consumed_at: "2026-04-24T12:00:01Z",
    ...overrides,
  };
}

describe("signedBytesForProof", () => {
  it("excludes signature and signing_key_id from the signed envelope", () => {
    const proof = baseProof({
      signature: "should-not-affect",
      signing_key_id: "should-not-affect-either",
    }) as Proof;
    const bytes = signedBytesForProof(proof);
    const text = new TextDecoder().decode(bytes);
    expect(text).not.toContain("should-not-affect");
    expect(text).not.toContain("signature");
    expect(text).not.toContain("signing_key_id");
  });

  it("serializes the 16 signed fields as canonical JSON", () => {
    const proof = baseProof() as Proof;
    const bytes = signedBytesForProof(proof);
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    expect(Object.keys(parsed).sort()).toEqual([
      "action",
      "agent",
      "audit_hash",
      "chain_hash",
      "consumed_at",
      "decision",
      "execution_hash",
      "execution_status",
      "issued_at",
      "org_id",
      "payload_hash",
      "permit_id",
      "policy_version",
      "previous_hash",
      "proof_id",
      "target",
    ]);
  });

  it("matches canonicalizePayload of the 16-field subset", () => {
    const proof = baseProof() as Proof;
    const envelope = {
      proof_id: proof.proof_id,
      permit_id: proof.permit_id,
      org_id: proof.org_id,
      agent: proof.agent,
      action: proof.action,
      target: proof.target,
      payload_hash: proof.payload_hash,
      policy_version: proof.policy_version,
      decision: proof.decision,
      execution_status: proof.execution_status,
      execution_hash: proof.execution_hash,
      audit_hash: proof.audit_hash,
      previous_hash: proof.previous_hash,
      chain_hash: proof.chain_hash,
      issued_at: proof.issued_at,
      consumed_at: proof.consumed_at,
    };
    const expected = new TextEncoder().encode(canonicalizePayload(envelope));
    expect(signedBytesForProof(proof)).toEqual(expected);
  });
});

describe("verifyProof — single proof", () => {
  let verifyKey: VerifyKey;
  let privateKey: webcrypto.CryptoKey;
  let wrongKey: VerifyKey;

  beforeAll(async () => {
    ({ verifyKey, privateKey } = await genKey("key-test"));
    ({ verifyKey: wrongKey } = await genKey("key-other"));
  });

  it("returns valid on a well-formed signed proof", async () => {
    const proof = baseProof();
    proof.signature = await signProof(privateKey, proof);
    const result = await verifyProof(proof as Proof, { keys: [verifyKey] }, GENESIS);
    expect(result.verification_status).toBe("valid");
    expect(result.signing_key_id).toBe("key-test");
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it("falls through to another key when the hint doesn't match (rotation)", async () => {
    const proof = baseProof({ signing_key_id: "key-unknown" });
    proof.signature = await signProof(privateKey, proof);
    // Pass both the wrong key AND the right key, but neither matches the hint.
    const result = await verifyProof(
      proof as Proof,
      { keys: [wrongKey, verifyKey] },
      GENESIS,
    );
    expect(result.verification_status).toBe("valid");
    expect(result.signing_key_id).toBe("key-test");
  });

  it("invalidates on tampered payload hash (signature no longer matches envelope)", async () => {
    const proof = baseProof();
    proof.signature = await signProof(privateKey, proof);
    proof.payload_hash = "f".repeat(64); // tamper after signing
    const result = await verifyProof(proof as Proof, { keys: [verifyKey] }, GENESIS);
    expect(result.verification_status).toBe("invalid");
    const sigCheck = result.checks.find((c) => c.name === "signature");
    expect(sigCheck?.passed).toBe(false);
    expect(sigCheck?.reason).toBe("invalid_signature");
  });

  it("invalidates on wrong key", async () => {
    const proof = baseProof();
    proof.signature = await signProof(privateKey, proof);
    const result = await verifyProof(proof as Proof, { keys: [wrongKey] }, GENESIS);
    expect(result.verification_status).toBe("invalid");
  });

  it("invalidates on empty keys array", async () => {
    const proof = baseProof();
    proof.signature = await signProof(privateKey, proof);
    const result = await verifyProof(proof as Proof, { keys: [] }, GENESIS);
    expect(result.verification_status).toBe("invalid");
    const sigCheck = result.checks.find((c) => c.name === "signature");
    expect(sigCheck?.reason).toBe("invalid_signature");
  });

  it("invalidates on empty signature string", async () => {
    const proof = baseProof({ signature: "" });
    const result = await verifyProof(proof as Proof, { keys: [verifyKey] }, GENESIS);
    const sigCheck = result.checks.find((c) => c.name === "signature");
    expect(sigCheck?.passed).toBe(false);
    expect(sigCheck?.reason).toBe("invalid_signature");
  });

  it("invalidates on malformed base64url signature", async () => {
    // "!" is outside the base64url alphabet — Buffer.from tolerates it,
    // but the decoded bytes won't verify as a valid Ed25519 signature.
    const proof = baseProof({ signature: "!!!not-base64!!!" });
    const result = await verifyProof(proof as Proof, { keys: [verifyKey] }, GENESIS);
    expect(result.verification_status).toBe("invalid");
  });

  it("fails chain_link when previous_hash doesn't match the chain tail", async () => {
    const proof = baseProof({ previous_hash: "d".repeat(64) });
    proof.signature = await signProof(privateKey, proof);
    const result = await verifyProof(proof as Proof, { keys: [verifyKey] }, GENESIS);
    const link = result.checks.find((c) => c.name === "chain_link");
    expect(link?.passed).toBe(false);
    expect(link?.reason).toBe("broken_chain");
  });

  it("skips chain_link when previousChainHash is null", async () => {
    const proof = baseProof({ previous_hash: "d".repeat(64) });
    proof.signature = await signProof(privateKey, proof);
    const result = await verifyProof(proof as Proof, { keys: [verifyKey] }, null);
    const link = result.checks.find((c) => c.name === "chain_link");
    expect(link?.passed).toBe(true);
  });

  it("flags payload_hash when the stored value isn't 64 hex", async () => {
    const proof = baseProof({ payload_hash: "not-hex" });
    proof.signature = await signProof(privateKey, proof);
    const result = await verifyProof(proof as Proof, { keys: [verifyKey] }, GENESIS);
    const h = result.checks.find((c) => c.name === "payload_hash");
    expect(h?.passed).toBe(false);
    expect(h?.reason).toBe("payload_hash_mismatch");
  });

  it("flags missing_policy_version when policy_version is empty", async () => {
    const proof = baseProof({ policy_version: "" });
    proof.signature = await signProof(privateKey, proof);
    const result = await verifyProof(proof as Proof, { keys: [verifyKey] }, GENESIS);
    const pv = result.checks.find((c) => c.name === "policy_version");
    expect(pv?.passed).toBe(false);
    expect(pv?.reason).toBe("missing_policy_version");
  });

  it("marks pending as incomplete in non-strict mode", async () => {
    const proof = baseProof({ execution_status: "pending", consumed_at: null });
    proof.signature = await signProof(privateKey, proof);
    const result = await verifyProof(proof as Proof, { keys: [verifyKey] }, GENESIS);
    expect(result.verification_status).toBe("incomplete");
    expect(result.reason).toBe("execution pending");
  });

  it("marks pending as invalid under strict: true", async () => {
    const proof = baseProof({ execution_status: "pending", consumed_at: null });
    proof.signature = await signProof(privateKey, proof);
    const result = await verifyProof(
      proof as Proof,
      { keys: [verifyKey], strict: true },
      GENESIS,
    );
    expect(result.verification_status).toBe("invalid");
    const exec = result.checks.find((c) => c.name === "execution_coherence");
    expect(exec?.reason).toBe("execution_not_consumed");
  });

  it("flags execution_not_consumed when failed lacks consumed_at", async () => {
    const proof = baseProof({ execution_status: "failed", consumed_at: null });
    proof.signature = await signProof(privateKey, proof);
    const result = await verifyProof(proof as Proof, { keys: [verifyKey] }, GENESIS);
    const exec = result.checks.find((c) => c.name === "execution_coherence");
    expect(exec?.passed).toBe(false);
    expect(exec?.reason).toBe("execution_not_consumed");
  });

  it("reports retired_signing_key when the hint isn't in the keyset", async () => {
    const proof = baseProof({ signing_key_id: "key-retired" });
    proof.signature = await signProof(privateKey, proof);
    // Only a different key is available; the hinted key was rotated out.
    const result = await verifyProof(proof as Proof, { keys: [wrongKey] }, GENESIS);
    const sig = result.checks.find((c) => c.name === "signature");
    expect(sig?.reason).toBe("retired_signing_key");
  });
});

describe("replayProofBundle — chain + aggregates", () => {
  let verifyKey: VerifyKey;
  let privateKey: webcrypto.CryptoKey;

  beforeAll(async () => {
    ({ verifyKey, privateKey } = await genKey("key-test"));
  });

  async function chainOf(n: number): Promise<Proof[]> {
    const chain: Proof[] = [];
    let prev = GENESIS;
    for (let i = 0; i < n; i += 1) {
      const proof = baseProof({
        proof_id: `proof-${i}`,
        previous_hash: prev,
        chain_hash: `${i.toString(16).padStart(2, "0").repeat(32)}`.slice(0, 64),
      });
      proof.signature = await signProof(privateKey, proof);
      chain.push(proof as Proof);
      prev = proof.chain_hash;
    }
    return chain;
  }

  it("reports all passed on a valid 3-proof chain", async () => {
    const bundle = await chainOf(3);
    const result = await replayProofBundle(bundle, { keys: [verifyKey] });
    expect(result.passed).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.incomplete).toBe(0);
    expect(result.proofs).toHaveLength(3);
  });

  it("catches a chain break in the middle of the bundle", async () => {
    const bundle = await chainOf(3);
    // Re-point proof[1].previous_hash to a bogus value; re-sign to
    // keep the signature valid over the tampered envelope.
    (bundle[1] as Proof).previous_hash = "f".repeat(64);
    (bundle[1] as Proof).signature = await signProof(privateKey, bundle[1] as Proof);
    const result = await replayProofBundle(bundle, { keys: [verifyKey] });
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(1);
    const link = result.proofs[1]!.checks.find((c) => c.name === "chain_link");
    expect(link?.passed).toBe(false);
    // Subsequent proofs still pass as long as their previous_hash
    // matches the actual (not expected) chain_hash of the broken
    // predecessor — verified above by passed === 2.
  });

  it("preserves input order in the result array", async () => {
    const bundle = await chainOf(4);
    const result = await replayProofBundle(bundle, { keys: [verifyKey] });
    for (let i = 0; i < 4; i += 1) {
      expect(result.proofs[i]!.proof_id).toBe(`proof-${i}`);
    }
  });

  it("tallies passed / failed / incomplete distinctly", async () => {
    const bundle = await chainOf(3);
    // Turn proof 1 into a pending proof (non-strict → incomplete),
    // turn proof 2 into an invalid-signature proof.
    (bundle[1] as Proof).execution_status = "pending";
    (bundle[1] as Proof).consumed_at = null;
    (bundle[1] as Proof).signature = await signProof(
      privateKey,
      bundle[1] as Proof,
    );
    (bundle[2] as Proof).signature = "invalid";
    const result = await replayProofBundle(bundle, { keys: [verifyKey] });
    expect(result.passed).toBe(1);
    expect(result.incomplete).toBe(1);
    expect(result.failed).toBe(1);
  });

  it("handles an empty bundle without error", async () => {
    const result = await replayProofBundle([], { keys: [verifyKey] });
    expect(result).toEqual({ passed: 0, failed: 0, incomplete: 0, proofs: [] });
  });
});
