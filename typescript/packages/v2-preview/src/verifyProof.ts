/**
 * Offline verification for v2 Pillar 9 Verifiable Proof Objects.
 *
 * Mirrors the role that `verifyAuditBundle` plays for the v1 audit
 * surface: given a bundle and a set of public keys, recompute every
 * integrity check locally, without hitting the API. Suitable for
 * auditors, regulators, and CI audit jobs.
 *
 * Checks run per proof (names match
 * `proof-verification-result.schema.json`):
 *
 *   1. `signature`          — Ed25519 signature valid under one of
 *                             the supplied public keys.
 *   2. `chain_link`         — `previous_hash` matches the prior
 *                             proof's `chain_hash` (genesis is
 *                             `"0".repeat(64)`).
 *   3. `payload_hash`       — `payload_hash` is the canonical 64-hex
 *                             SHA-256 format. We can't verify its
 *                             contents offline (raw payload is not
 *                             shipped on the wire), so this is a
 *                             structural check.
 *   4. `policy_version`     — `policy_version` is present and
 *                             non-empty. "Retired key" / "unknown
 *                             policy" checks require a live registry
 *                             and are the server's job.
 *   5. `execution_coherence` — `execution_status` is terminal
 *                             (`executed` or `failed`). `pending`
 *                             produces `verification_status:
 *                             "incomplete"` unless `strict: true`.
 *
 * Open contract question (flagged on PR #61): the schema's
 * declaration calls out 18 fields but `signature` and `signing_key_id`
 * can't be inside the bytes they cover. This implementation follows
 * v1's `signedBytesFor` precedent — sign the 16-field subset in
 * declaration order, ship `signature` and `signing_key_id` alongside.
 * Clarification needed before v2 GA.
 */

import { webcrypto } from "node:crypto";

import { canonicalizePayload } from "./canonicalize.js";
import type {
  Proof,
  ProofCheckName,
  ProofFailureReason,
  ProofVerificationCheck,
  ProofVerificationStatus,
} from "./types.js";

const GENESIS_HASH = "0".repeat(64);
const HASH_HEX = /^[0-9a-f]{64}$/;

/**
 * The 16 Proof fields covered by the Ed25519 signature, in their
 * canonical envelope order. Derived from
 * `contract/schemas/v2/proof.schema.json` declaration order with
 * `signature` and `signing_key_id` removed. Reordering here is a
 * breaking change — matches the role of v1's `signedBytesFor`.
 */
const SIGNED_ENVELOPE_FIELDS = [
  "proof_id",
  "permit_id",
  "org_id",
  "agent",
  "action",
  "target",
  "payload_hash",
  "policy_version",
  "decision",
  "execution_status",
  "execution_hash",
  "audit_hash",
  "previous_hash",
  "chain_hash",
  "issued_at",
  "consumed_at",
] as const;

type SignedField = (typeof SIGNED_ENVELOPE_FIELDS)[number];

/** Node's webcrypto `CryptoKey` — kept local so we don't depend on DOM types. */
type WebCryptoKey = webcrypto.CryptoKey;

/** Candidate public key tagged with its registry id. */
export interface VerifyKey {
  keyId: string;
  publicKey: WebCryptoKey;
}

/** Options accepted by {@link replayProofBundle}. */
export interface ReplayProofBundleOptions {
  /** Candidate public keys. Verifier tries `signing_key_id` first, then the rest (rotation). */
  keys: readonly VerifyKey[];
  /**
   * When true, proofs with `execution_status: "pending"` count as
   * failures rather than incomplete. Defaults to `false` so auditors
   * can distinguish "not-yet-complete" from "actually broken".
   */
  strict?: boolean;
}

/** One proof's verification outcome. */
export interface ProofVerificationEntry {
  /** Echo of `Proof.proof_id`. */
  proof_id: string;
  /** Top-level verdict — matches the shape of the online `/verify` endpoint. */
  verification_status: ProofVerificationStatus;
  /** Registry id of the key whose signature verified (absent on failure). */
  signing_key_id?: string;
  /** Per-check breakdown. Names match `ProofCheckName`. */
  checks: ProofVerificationCheck[];
  /** Short human-readable summary. Handy for log lines. */
  reason?: string;
}

/** Aggregate result across a whole bundle. */
export interface ProofBundleVerificationResult {
  /** Count where every check passed. */
  passed: number;
  /** Count where at least one check failed. */
  failed: number;
  /** Count where the proof was well-formed but pending (non-strict mode only). */
  incomplete: number;
  /** Per-proof outcomes, in input order. */
  proofs: ProofVerificationEntry[];
}

/**
 * Recreate the exact bytes covered by the Ed25519 signature on a
 * Proof. Callers who want to re-sign a Proof (e.g. key rotation)
 * feed this output to their Ed25519 signing key.
 */
export function signedBytesForProof(proof: Proof): Uint8Array {
  const envelope: Record<string, unknown> = {};
  const proofAsRecord = proof as unknown as Record<string, unknown>;
  for (const field of SIGNED_ENVELOPE_FIELDS) {
    envelope[field] = proofAsRecord[field];
  }
  return new TextEncoder().encode(canonicalizePayload(envelope));
}

/**
 * Verify a single Proof object against a set of candidate public keys.
 * Used by {@link replayProofBundle}; also exported for callers who
 * have a single proof and no chain context.
 *
 * `previousChainHash` is what the prior proof in the chain reported
 * as its `chain_hash` (or `"0".repeat(64)` for the genesis proof).
 * Pass `null` to skip the `chain_link` check — appropriate when a
 * single standalone proof is verified out of any bundle context.
 */
export async function verifyProof(
  proof: Proof,
  options: ReplayProofBundleOptions,
  previousChainHash: string | null,
): Promise<ProofVerificationEntry> {
  const checks: ProofVerificationCheck[] = [];

  // 1. signature
  const sigCheck = await verifySignature(proof, options.keys);
  checks.push(sigCheck.check);

  // 2. chain_link
  checks.push(checkChainLink(proof, previousChainHash));

  // 3. payload_hash (structural)
  checks.push(checkPayloadHashFormat(proof));

  // 4. policy_version (non-empty)
  checks.push(checkPolicyVersionPresent(proof));

  // 5. execution_coherence
  const execCheck = checkExecutionCoherence(proof, options.strict ?? false);
  checks.push(execCheck.check);

  // Roll up.
  const failed = checks.find((c) => !c.passed && c.name !== "execution_coherence");
  const terminalStatus: ProofVerificationStatus = failed
    ? "invalid"
    : execCheck.pending && !(options.strict ?? false)
      ? "incomplete"
      : execCheck.check.passed
        ? "valid"
        : "invalid";

  const entry: ProofVerificationEntry = {
    proof_id: proof.proof_id,
    verification_status: terminalStatus,
    checks,
  };
  if (sigCheck.matchedKeyId !== undefined) {
    entry.signing_key_id = sigCheck.matchedKeyId;
  }
  const reason = summarize(terminalStatus, checks);
  if (reason !== undefined) entry.reason = reason;
  return entry;
}

/**
 * Replay a bundle of proofs against a set of candidate public keys.
 * Returns per-proof outcomes plus aggregate counts — designed for
 * CI audit jobs that want a single "did everything pass?" assertion.
 *
 * Input ordering matters: `chain_link` checks each proof's
 * `previous_hash` against its predecessor's `chain_hash`. Bundles
 * assembled out of order will report chain_link failures even if
 * every signature is valid.
 */
export async function replayProofBundle(
  bundle: readonly Proof[],
  options: ReplayProofBundleOptions,
): Promise<ProofBundleVerificationResult> {
  const proofs: ProofVerificationEntry[] = [];
  let prevChainHash: string | null = GENESIS_HASH;
  for (const proof of bundle) {
    const entry = await verifyProof(proof, options, prevChainHash);
    proofs.push(entry);
    prevChainHash = proof.chain_hash;
  }

  let passed = 0;
  let failed = 0;
  let incomplete = 0;
  for (const p of proofs) {
    if (p.verification_status === "valid") passed += 1;
    else if (p.verification_status === "incomplete") incomplete += 1;
    else failed += 1;
  }
  return { passed, failed, incomplete, proofs };
}

// ─── Internals ────────────────────────────────────────────────────────

async function verifySignature(
  proof: Proof,
  keys: readonly VerifyKey[],
): Promise<{
  check: ProofVerificationCheck;
  matchedKeyId?: string;
}> {
  const checkName: ProofCheckName = "signature";
  if (keys.length === 0) {
    return {
      check: makeFailed(checkName, "invalid_signature"),
    };
  }
  if (!proof.signature) {
    return {
      check: makeFailed(checkName, "invalid_signature"),
    };
  }

  let sigBytes: Uint8Array;
  try {
    sigBytes = base64UrlDecode(proof.signature);
  } catch {
    return {
      check: makeFailed(checkName, "invalid_signature"),
    };
  }
  const envelope = signedBytesForProof(proof);

  // Try the advertised key first, then the rest (rotation).
  const hint = proof.signing_key_id;
  const ordered = hint
    ? [
        ...keys.filter((k) => k.keyId === hint),
        ...keys.filter((k) => k.keyId !== hint),
      ]
    : [...keys];

  for (const candidate of ordered) {
    let ok = false;
    try {
      ok = await webcrypto.subtle.verify(
        "Ed25519",
        candidate.publicKey,
        sigBytes,
        envelope,
      );
    } catch {
      continue;
    }
    if (ok) {
      return {
        check: { name: checkName, passed: true },
        matchedKeyId: candidate.keyId,
      };
    }
  }
  // No key matched — treat as retired_signing_key if we tried the
  // hint's key id and still failed, otherwise invalid_signature.
  const reason: ProofFailureReason =
    hint && !keys.some((k) => k.keyId === hint)
      ? "retired_signing_key"
      : "invalid_signature";
  return { check: makeFailed(checkName, reason) };
}

function checkChainLink(
  proof: Proof,
  previousChainHash: string | null,
): ProofVerificationCheck {
  if (previousChainHash === null) {
    // Caller opted out of chain-link checking.
    return { name: "chain_link", passed: true };
  }
  if (proof.previous_hash !== previousChainHash) {
    return makeFailed("chain_link", "broken_chain");
  }
  if (!HASH_HEX.test(proof.chain_hash)) {
    return makeFailed("chain_link", "broken_chain");
  }
  return { name: "chain_link", passed: true };
}

function checkPayloadHashFormat(proof: Proof): ProofVerificationCheck {
  if (!HASH_HEX.test(proof.payload_hash)) {
    return makeFailed("payload_hash", "payload_hash_mismatch");
  }
  return { name: "payload_hash", passed: true };
}

function checkPolicyVersionPresent(proof: Proof): ProofVerificationCheck {
  if (!proof.policy_version) {
    return makeFailed("policy_version", "missing_policy_version");
  }
  return { name: "policy_version", passed: true };
}

function checkExecutionCoherence(
  proof: Proof,
  strict: boolean,
): { check: ProofVerificationCheck; pending: boolean } {
  if (proof.execution_status === "pending") {
    if (strict) {
      return {
        check: makeFailed("execution_coherence", "execution_not_consumed"),
        pending: true,
      };
    }
    // Non-strict: surface as a "not passed" check so the caller can
    // still see what was pending, but the overall status upgrades to
    // "incomplete" (not "invalid").
    return {
      check: { name: "execution_coherence", passed: false, reason: "execution_not_consumed" },
      pending: true,
    };
  }
  if (proof.execution_status === "failed" && proof.consumed_at === null) {
    return {
      check: makeFailed("execution_coherence", "execution_not_consumed"),
      pending: false,
    };
  }
  return {
    check: { name: "execution_coherence", passed: true },
    pending: false,
  };
}

function summarize(
  status: ProofVerificationStatus,
  checks: ProofVerificationCheck[],
): string | undefined {
  if (status === "valid") return undefined;
  const failed = checks.find((c) => !c.passed);
  if (!failed) return undefined;
  if (status === "incomplete") return "execution pending";
  return failed.reason ?? failed.name;
}

function makeFailed(
  name: ProofCheckName,
  reason: ProofFailureReason,
): ProofVerificationCheck {
  return { name, passed: false, reason };
}

function base64UrlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = Buffer.from(b64, "base64");
  return new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength);
}
