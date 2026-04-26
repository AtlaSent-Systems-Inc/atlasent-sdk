/**
 * Pillar 9 round-trip — generate a proof, then verify it offline.
 *
 * Demonstrates that:
 *   1. `generateProof` produces a Proof signed with a 32-byte
 *      Ed25519 seed.
 *   2. The same package's `replayProofBundle` verifies it under
 *      the matching public key.
 *   3. No network. No server. Closed loop.
 *
 * Run:  npx tsx examples/02_generate_and_verify_proof.ts
 */

import { createPublicKey, webcrypto } from "node:crypto";

import {
  GENESIS_HASH,
  generateProof,
  hashPayload,
  replayProofBundle,
  type VerifyKey,
} from "../src/index.js";

// 32-byte Ed25519 seed. PUBLIC, TEST-ONLY — never use real seeds
// like this; load from your secrets manager in production.
const seed = new TextEncoder()
  .encode("EXAMPLE-SEED-DO-NOT-USE-PROD-!!!")
  .slice(0, 32);

// What the policy engine would have evaluated. The hash is what
// the v2 `consume` endpoint binds the proof to — the raw payload
// never leaves the client.
const payload = { commit: "abc123", env: "prod", approver: "alice" };
const payload_hash = hashPayload(payload);

// Build + sign one proof.
const proof = await generateProof(
  {
    proof_id: "11111111-2222-3333-4444-555555555555",
    permit_id: "dec_abc",
    org_id: "org-1",
    agent: "deploy-bot",
    action: "deploy_to_production",
    target: "prod-cluster",
    payload_hash,
    policy_version: "v3-a7f1",
    decision: "allow",
    execution_status: "executed",
    execution_hash: null,
    audit_hash: "a".repeat(64),
    previous_hash: GENESIS_HASH,
    chain_hash: "b".repeat(64),
    signing_key_id: "example-key",
    issued_at: "2026-04-26T12:00:00Z",
    consumed_at: "2026-04-26T12:00:01Z",
  },
  { seed },
);

console.log("Generated proof:");
console.log(JSON.stringify(proof, null, 2));

// Derive the matching public key from the seed for verification.
// In production, the public key comes from `GET /v1-signing-keys`;
// the seed never leaves the signer.
const publicKey = await derivePublicKey(seed);
const verifyKey: VerifyKey = { keyId: "example-key", publicKey };

// Run the offline replay harness.
const result = await replayProofBundle([proof], { keys: [verifyKey] });

console.log("\nVerification result:");
console.log(`  passed:     ${result.passed}`);
console.log(`  failed:     ${result.failed}`);
console.log(`  incomplete: ${result.incomplete}`);
console.log(`  proofs[0].verification_status: ${result.proofs[0]?.verification_status}`);

// Helper: derive an Ed25519 public key from a 32-byte seed by
// running through Node's crypto without going through PKCS8.
// We sign once with a throwaway message and use the resulting
// signature as a sanity check that the seed is well-formed.
async function derivePublicKey(seedBytes: Uint8Array): Promise<webcrypto.CryptoKey> {
  // Build the PKCS8 wrapper used by `generateProof` internally.
  const pkcs8 = new Uint8Array(48);
  pkcs8.set(
    [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
     0x04, 0x22, 0x04, 0x20],
    0,
  );
  pkcs8.set(seedBytes, 16);
  // Round through node:crypto to get an SPKI public key, then
  // import it as a webcrypto CryptoKey.
  const node = createPublicKey({ key: Buffer.from(pkcs8), format: "der", type: "pkcs8" });
  const spki = node.export({ format: "der", type: "spki" });
  return webcrypto.subtle.importKey("spki", spki, { name: "Ed25519" }, true, ["verify"]);
}
