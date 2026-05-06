/**
 * Tests for Economic Evidence Bundles.
 *
 * Covers: signable content construction, serialization, bundle structure
 * verification, permit ID consistency checks, and signature presence.
 */
import { describe, expect, it } from "vitest";
import {
  buildSignableContent,
  serializeSignableContent,
  verifyEvidenceBundleStructure,
  type EconomicEvidenceBundle,
} from "../src/economicEvidence.js";
import type { FinancialExecutionRecord } from "../src/financialAction.js";
import type { LiabilityAttributionRecord } from "../src/liabilityAttribution.js";
import type { FinancialQuorumResult } from "../src/financialQuorum.js";
import type { BudgetConstraintCheckResult } from "../src/budgetaryGovernance.js";

const EXEC_RECORD: FinancialExecutionRecord = {
  execution_id:              "exec-001",
  action_class_id:           "wire_transfer.domestic",
  org_id:                    "org-abc",
  action_value:              15_000,
  currency:                  "USD",
  risk_tier:                 "medium",
  liability_classification:  "shared",
  initiator_id:              "user-fm",
  executor_id:               "agent-payments",
  approver_ids:              ["user-cfo", "user-fm"],
  permit_ids:                ["pmt-001", "pmt-002"],
  override_applied:          false,
  override_id:               null,
  status:                    "completed",
  authorized_at:             "2026-01-01T10:00:00Z",
  executed_at:               "2026-01-01T10:05:00Z",
  audit_hash:                "a".repeat(64),
  context:                   {},
};

const ATTRIBUTION: LiabilityAttributionRecord = {
  attribution_id:       "attr-001",
  execution_id:         "exec-001",
  org_id:               "org-abc",
  classification:       "shared",
  risk_tier:            "medium",
  liability_chain:      [],
  delegation_present:   false,
  supervisory_present:  false,
  emergency_override:   false,
  override_justification: null,
  created_at:           "2026-01-01T10:05:00Z",
  chain_hash:           "b".repeat(64),
};

const QUORUM_RESULT: FinancialQuorumResult = {
  passed:                      true,
  base_quorum_passed:          true,
  amount_threshold_satisfied:  true,
  financial_roles_satisfied:   true,
  regulator_approval_missing:  false,
  blocked_by_freeze:           false,
  base_quorum_proof:           null,
  denial_reason:               null,
  unmet_requirements:          [],
};

const BUDGET_CHECK: BudgetConstraintCheckResult = {
  permitted:            true,
  hard_blocks:          [],
  soft_warnings:        [],
  limits_checked:       [],
  constraints_checked:  [],
};

const VALID_BUNDLE: EconomicEvidenceBundle = {
  version:                   "economic_evidence.v1",
  bundle_id:                 "bndl-001",
  org_id:                    "org-abc",
  purpose:                   "financial_audit",
  execution_record:          EXEC_RECORD,
  liability_attribution:     ATTRIBUTION,
  quorum_result:             QUORUM_RESULT,
  budget_check:              BUDGET_CHECK,
  approval_provenance: [
    { approver_id: "user-cfo", approver_label: "CFO",             permit_id: "pmt-001", approved_at: "2026-01-01T09:50:00Z", audit_hash: "c".repeat(64), role: "cfo" },
    { approver_id: "user-fm",  approver_label: "Finance Manager", permit_id: "pmt-002", approved_at: "2026-01-01T09:55:00Z", audit_hash: "d".repeat(64), role: "finance_manager" },
  ],
  runtime_conformity:         true,
  runtime_conformity_notes:   [],
  policy_compliant:           true,
  policy_violations:          [],
  generated_at:               "2026-01-01T10:10:00Z",
  requested_by:               "user-auditor",
  content_hash:               "e".repeat(64),
  signature:                  "c2lnbmF0dXJl",
  signing_key_id:             "key-001",
};

describe("buildSignableContent", () => {
  it("includes all required fields", () => {
    const content = buildSignableContent(VALID_BUNDLE);
    expect(content.bundle_id).toBe("bndl-001");
    expect(content.execution_id).toBe("exec-001");
    expect(content.attribution_id).toBe("attr-001");
    expect(content.liability_chain_hash).toBe(ATTRIBUTION.chain_hash);
    expect(content.approval_count).toBe(2);
    expect(content.permit_ids).toEqual(["pmt-001", "pmt-002"]);
    expect(content.policy_compliant).toBe(true);
  });

  it("includes purpose and org_id", () => {
    const content = buildSignableContent(VALID_BUNDLE);
    expect(content.purpose).toBe("financial_audit");
    expect(content.org_id).toBe("org-abc");
  });
});

describe("serializeSignableContent", () => {
  it("returns a non-empty Uint8Array", () => {
    const content = buildSignableContent(VALID_BUNDLE);
    const bytes = serializeSignableContent(content);
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("produces deterministic output for the same content", () => {
    const content = buildSignableContent(VALID_BUNDLE);
    const a = serializeSignableContent(content);
    const b = serializeSignableContent(content);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("produces sorted-key canonical JSON", () => {
    const content = buildSignableContent(VALID_BUNDLE);
    const decoded = new TextDecoder().decode(serializeSignableContent(content));
    const parsed = JSON.parse(decoded);
    const keys = Object.keys(parsed);
    expect(keys).toEqual([...keys].sort());
  });
});

describe("verifyEvidenceBundleStructure", () => {
  it("returns valid for a well-formed bundle", () => {
    const result = verifyEvidenceBundleStructure(VALID_BUNDLE);
    expect(result.valid).toBe(true);
    expect(result.reason).toBeNull();
  });

  it("reports invalid content_hash when length is wrong", () => {
    const bad = { ...VALID_BUNDLE, content_hash: "short" };
    const result = verifyEvidenceBundleStructure(bad);
    expect(result.valid).toBe(false);
    expect(result.content_hash_valid).toBe(false);
  });

  it("reports permit_ids_match false when provenance has unknown permit", () => {
    const bad: EconomicEvidenceBundle = {
      ...VALID_BUNDLE,
      approval_provenance: [
        { ...VALID_BUNDLE.approval_provenance[0]!, permit_id: "pmt-UNKNOWN" },
      ],
    };
    const result = verifyEvidenceBundleStructure(bad);
    expect(result.permit_ids_match).toBe(false);
  });

  it("reports signature_valid false when signature is null", () => {
    const bad = { ...VALID_BUNDLE, signature: null };
    const result = verifyEvidenceBundleStructure(bad);
    expect(result.signature_valid).toBe(false);
  });

  it("reports signature_valid true when signature is present", () => {
    const result = verifyEvidenceBundleStructure(VALID_BUNDLE);
    expect(result.signature_valid).toBe(true);
  });

  it("reports liability_chain_hash_matches false for empty chain hash", () => {
    const bad: EconomicEvidenceBundle = {
      ...VALID_BUNDLE,
      liability_attribution: { ...ATTRIBUTION, chain_hash: "" },
    };
    const result = verifyEvidenceBundleStructure(bad);
    expect(result.liability_chain_hash_matches).toBe(false);
  });
});
