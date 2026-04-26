/**
 * TypeScript-side proof generator — sibling of
 * `contract/tools/gen_proof_bundles.py`.
 *
 * Closes the toolchain symmetry: until this lands, only Python could
 * *generate* signed proof fixtures. The TS preview could only verify
 * what Python produced. With this, TS toolchains can produce signed
 * proofs that Python verifies (and vice versa) — anchored by the
 * same RFC 8032 deterministic-Ed25519 contract that PR #93 locked
 * in for the verification side.
 *
 * Use cases:
 *
 *   * TS-only customer wiring custom proof generation (e.g., a
 *     bridge that re-signs proofs under a customer-side key).
 *   * Test fixtures for a TS-only consumer (e.g., a future browser
 *     SDK) that can't run Python.
 *   * Re-key / re-sign tooling for proof rotation.
 *
 * The generator does NOT call any HTTP endpoint. It produces the
 * full signed Proof envelope client-side from inputs the caller
 * provides. At v2 GA the *server* mints proofs as part of consume;
 * this generator stays useful for the cases above.
 */

import { webcrypto } from "node:crypto";

import { signedBytesForProof } from "./verifyProof.js";
import type { Proof, ProofDecision, ProofExecutionStatus } from "./types.js";

/** PKCS8 DER prefix for an Ed25519 private key (16 bytes). */
const PKCS8_ED25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
  0x04, 0x22, 0x04, 0x20,
]);

/**
 * Inputs to {@link generateProof}. Mirrors the user-controllable
 * fields on a {@link Proof}; the generator computes / fills the
 * cryptographic + ordering fields.
 */
export interface GenerateProofInput {
  /** Server-assigned UUID (or your own deterministic id). */
  proof_id: string;
  /** Decision id from the originating evaluate call. */
  permit_id: string;
  /** Organization id. */
  org_id: string;
  /** Agent identifier. */
  agent: string;
  /** Action being authorized. */
  action: string;
  /** Target resource — empty string when not applicable. */
  target: string;
  /** SHA-256 hex of the canonicalized payload. */
  payload_hash: string;
  /** Policy bundle version that produced the decision. */
  policy_version: string;
  /** Policy decision. */
  decision: ProofDecision;
  /** Outcome of the wrapped callback. */
  execution_status: ProofExecutionStatus;
  /** Optional execution metadata hash. `null` to omit. */
  execution_hash: string | null;
  /** Audit-chain entry id for this proof's row. */
  audit_hash: string;
  /** Prior proof's `chain_hash` (or `"0".repeat(64)` for genesis). */
  previous_hash: string;
  /** This proof's chain hash (typically `SHA-256(previous_hash || canonicalJSON(payload))`). */
  chain_hash: string;
  /** Registry id of the signing key. */
  signing_key_id: string;
  /** ISO 8601 timestamp of issuance. */
  issued_at: string;
  /** ISO 8601 timestamp of consume completion (or `null`). */
  consumed_at: string | null;
}

/** Options for {@link generateProof}. */
export interface GenerateProofOptions {
  /**
   * 32-byte Ed25519 seed. Both `Uint8Array` and `Buffer` accepted.
   * Sign output is deterministic per RFC 8032.
   */
  seed: Uint8Array;
}

/**
 * Build a fully-signed {@link Proof} from caller-provided inputs.
 *
 * The signature is deterministic (RFC 8032) — same seed + same
 * inputs produce byte-identical output across TS and Python and
 * any other RFC-conforming Ed25519 implementation. PR #93 locks
 * this property in for the TS-vs-Python case via 18 byte-equal
 * signature assertions.
 *
 * Throws if `seed` is the wrong length.
 */
export async function generateProof(
  input: GenerateProofInput,
  options: GenerateProofOptions,
): Promise<Proof> {
  if (options.seed.length !== 32) {
    throw new Error(
      `generateProof: seed must be 32 bytes, got ${options.seed.length}`,
    );
  }

  // Build the unsigned envelope first — `signature` is empty so
  // `signedBytesForProof` strips it (along with `signing_key_id`)
  // when reconstructing the canonical 16-field signed bytes.
  const unsigned: Proof = {
    proof_id: input.proof_id,
    permit_id: input.permit_id,
    org_id: input.org_id,
    agent: input.agent,
    action: input.action,
    target: input.target,
    payload_hash: input.payload_hash,
    policy_version: input.policy_version,
    decision: input.decision,
    execution_status: input.execution_status,
    execution_hash: input.execution_hash,
    audit_hash: input.audit_hash,
    previous_hash: input.previous_hash,
    chain_hash: input.chain_hash,
    signing_key_id: input.signing_key_id,
    signature: "",
    issued_at: input.issued_at,
    consumed_at: input.consumed_at,
  };

  const privateKey = await privateKeyFromSeed(options.seed);
  const sigBytes = await webcrypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    signedBytesForProof(unsigned),
  );

  return { ...unsigned, signature: base64UrlEncode(new Uint8Array(sigBytes)) };
}

/**
 * Build a chain of signed proofs in one call. Each successive proof's
 * `previous_hash` is set to the prior proof's `chain_hash`. Genesis
 * uses `"0".repeat(64)` as the prior hash.
 *
 * Convenience for callers who'd otherwise loop manually. Inputs MUST
 * provide their own `chain_hash` per proof — the generator doesn't
 * compute it (computing it requires hashing the full event payload,
 * which lives outside this module's contract).
 */
export async function generateProofChain(
  inputs: ReadonlyArray<Omit<GenerateProofInput, "previous_hash">>,
  options: GenerateProofOptions,
): Promise<Proof[]> {
  const out: Proof[] = [];
  let prev = GENESIS_HASH;
  for (const input of inputs) {
    const signed = await generateProof(
      { ...input, previous_hash: prev },
      options,
    );
    out.push(signed);
    prev = signed.chain_hash;
  }
  return out;
}

/** Genesis sentinel — the `previous_hash` of the first proof in a chain. */
export const GENESIS_HASH = "0".repeat(64);

// ─── Internals ────────────────────────────────────────────────────────

async function privateKeyFromSeed(
  seed: Uint8Array,
): Promise<webcrypto.CryptoKey> {
  const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
  pkcs8.set(PKCS8_ED25519_PREFIX, 0);
  pkcs8.set(seed, PKCS8_ED25519_PREFIX.length);
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
