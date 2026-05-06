/**
 * Economic Evidence Bundles.
 *
 * Generates signed evidence proving approval provenance, execution
 * authorization, runtime conformity, liability chain, and policy compliance
 * for regulatory review, insurance, financial audit, and legal discovery.
 *
 * Follows the same signing pattern as auditBundle.ts, scoped to financial
 * governance evidence.
 *
 * Wire-stable as `economic_evidence.v1`.
 */

import type { FinancialExecutionRecord } from "./financialAction.js";
import type { LiabilityAttributionRecord } from "./liabilityAttribution.js";
import type { FinancialQuorumResult } from "./financialQuorum.js";
import type { BudgetConstraintCheckResult } from "./budgetaryGovernance.js";

/** Purpose for which an economic evidence bundle is generated. */
export type EvidencePurpose =
  | "regulator_review"
  | "insurance_review"
  | "financial_audit"
  | "legal_discovery"
  | "internal_review"
  | "dispute_resolution";

/** Approval provenance record within the evidence bundle. */
export interface ApprovalProvenance {
  readonly approver_id: string;
  readonly approver_label: string;
  readonly permit_id: string;
  readonly approved_at: string;
  readonly audit_hash: string;
  readonly role: string;
}

/** Complete economic evidence bundle. */
export interface EconomicEvidenceBundle {
  readonly version: "economic_evidence.v1";
  readonly bundle_id: string;
  readonly org_id: string;
  readonly purpose: EvidencePurpose;
  readonly execution_record: FinancialExecutionRecord;
  readonly liability_attribution: LiabilityAttributionRecord;
  readonly quorum_result: FinancialQuorumResult;
  readonly budget_check: BudgetConstraintCheckResult;
  readonly approval_provenance: readonly ApprovalProvenance[];
  readonly runtime_conformity: boolean;
  readonly runtime_conformity_notes: readonly string[];
  readonly policy_compliant: boolean;
  readonly policy_violations: readonly string[];
  readonly generated_at: string;
  readonly requested_by: string;
  /** SHA-256 hex of the canonical signable content. */
  readonly content_hash: string;
  /** Base64url Ed25519 signature of the canonical content. */
  readonly signature: string | null;
  readonly signing_key_id: string | null;
}

/** Canonical content shape that gets hashed and signed. */
export interface EvidenceBundleSignableContent {
  readonly bundle_id: string;
  readonly org_id: string;
  readonly purpose: EvidencePurpose;
  readonly execution_id: string;
  readonly attribution_id: string;
  readonly liability_chain_hash: string;
  readonly approval_count: number;
  readonly permit_ids: readonly string[];
  readonly policy_compliant: boolean;
  readonly generated_at: string;
}

/** Verification result for an economic evidence bundle. */
export interface EvidenceBundleVerificationResult {
  readonly valid: boolean;
  readonly content_hash_valid: boolean;
  readonly signature_valid: boolean;
  readonly liability_chain_hash_matches: boolean;
  readonly permit_ids_match: boolean;
  readonly reason: string | null;
}

function canonicalizeForEvidence(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalizeForEvidence).join(",") + "]";
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalizeForEvidence(obj[k])).join(",") + "}";
  }
  return "null";
}

/**
 * Build the signable content object for a bundle.
 * Key order is load-bearing — must remain stable across versions.
 */
export function buildSignableContent(
  bundle: Omit<EconomicEvidenceBundle, "content_hash" | "signature" | "signing_key_id">,
): EvidenceBundleSignableContent {
  return {
    bundle_id:             bundle.bundle_id,
    org_id:                bundle.org_id,
    purpose:               bundle.purpose,
    execution_id:          bundle.execution_record.execution_id,
    attribution_id:        bundle.liability_attribution.attribution_id,
    liability_chain_hash:  bundle.liability_attribution.chain_hash,
    approval_count:        bundle.approval_provenance.length,
    permit_ids:            bundle.approval_provenance.map((a) => a.permit_id),
    policy_compliant:      bundle.policy_compliant,
    generated_at:          bundle.generated_at,
  };
}

/**
 * Serialize signable content to canonical UTF-8 bytes.
 * Uses the same sort-keyed canonicalization as auditBundle.
 */
export function serializeSignableContent(
  content: EvidenceBundleSignableContent,
): Uint8Array {
  return new TextEncoder().encode(canonicalizeForEvidence(content));
}

/**
 * Verify an economic evidence bundle's structural integrity.
 * Does NOT verify the Ed25519 signature (requires crypto keys).
 */
export function verifyEvidenceBundleStructure(
  bundle: EconomicEvidenceBundle,
): EvidenceBundleVerificationResult {
  const errors: string[] = [];

  // Permit ID consistency between provenance and execution record
  const bundlePermitIds = new Set(bundle.execution_record.permit_ids);
  const provenancePermitIds = bundle.approval_provenance.map((a) => a.permit_id);
  const permitIdsMatch = provenancePermitIds.every((id) => bundlePermitIds.has(id));
  if (!permitIdsMatch) {
    errors.push("permit IDs in approval provenance do not all appear in execution record");
  }

  // Content hash format check (SHA-256 hex = 64 chars)
  const contentHashValid = typeof bundle.content_hash === "string" && bundle.content_hash.length === 64;
  if (!contentHashValid) errors.push("content_hash appears invalid (expected 64-char hex)");

  // Liability chain hash presence
  const liabilityChainHashMatches =
    typeof bundle.liability_attribution.chain_hash === "string" &&
    bundle.liability_attribution.chain_hash.length > 0;
  if (!liabilityChainHashMatches) errors.push("liability_attribution.chain_hash is missing or empty");

  const signatureValid = bundle.signature !== null && bundle.signature.length > 0;

  return {
    valid:                       errors.length === 0 && contentHashValid,
    content_hash_valid:          contentHashValid,
    signature_valid:             signatureValid,
    liability_chain_hash_matches: liabilityChainHashMatches,
    permit_ids_match:            permitIdsMatch,
    reason:                      errors.length === 0 ? null : errors[0] ?? "bundle integrity check failed",
  };
}
