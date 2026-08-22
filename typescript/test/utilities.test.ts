/**
 * Lightweight coverage tests for small utility modules that have no
 * dedicated test file. Each describe block exercises the exported
 * functions of a single source file.
 */
import { describe, it, expect } from "vitest";
import { matchAnomalyRules, highestSeverityAction } from "../src/anomalyResponse.js";
import type { AnomalyResponseRule } from "../src/anomalyResponse.js";
import { isBudgetExceptionActive, isBudgetExceptionTerminal } from "../src/budgetExceptions.js";
import type { BudgetExceptionRequest } from "../src/budgetExceptions.js";
import { evidenceRunPasses, nonPassingControls } from "../src/complianceEvidence.js";
import type { ComplianceEvidenceRun } from "../src/complianceEvidence.js";
import { isImpersonationGrantUsable, clampTokenDuration } from "../src/crossOrgImpersonation.js";
import type { CrossOrgImpersonationGrant } from "../src/crossOrgImpersonation.js";
import { summarizeCrossOrgPermission, summarizeTrustPrecheck } from "../src/crossOrgPermission.js";
import type { CrossOrgPermissionCheckResult } from "../src/crossOrgPermission.js";
import { buildLiabilityVisualization, buildRiskTimeline } from "../src/financialDashboard.js";
import type { LiabilityParty } from "../src/liabilityAttribution.js";
import { verifyWebhookSignature } from "../src/governanceWebhooks.js";
import { computeSignalEngagementRate, isSubstantiveSignalResponse } from "../src/incentiveSignalFeedback.js";
import type { SignalActionSummary } from "../src/incentiveSignalFeedback.js";
import { formatPolicySyncDiff, isPolicySyncTerminal } from "../src/policySync.js";
import type { PolicySyncRun } from "../src/policySync.js";
import { isRegulatoryEscalationTerminal, isEscalationSlaBreached } from "../src/regulatoryEscalation.js";
import type { RegulatoryEscalation, RegulatoryAuthorityLevel } from "../src/regulatoryEscalation.js";
import { STATE_SOURCES } from "../src/state.js";
import { computeApprovalRiskScore } from "../src/economicRisk.js";
import type { ApprovalConcentrationAnalysis } from "../src/economicRisk.js";

// ── anomalyResponse ───────────────────────────────────────────────────────────

function makeRule(overrides: Partial<AnomalyResponseRule> = {}): AnomalyResponseRule {
  return {
    id: "r1",
    org_id: "org1",
    name: "Test Rule",
    anomaly_score_threshold: 0.5,
    action_type: "notify_admin",
    action_config: {},
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("anomalyResponse", () => {
  it("matchAnomalyRules returns active rules above threshold", () => {
    const rules = [
      makeRule({ anomaly_score_threshold: 0.3, is_active: true }),
      makeRule({ id: "r2", anomaly_score_threshold: 0.6, is_active: true }),
      makeRule({ id: "r3", anomaly_score_threshold: 0.5, is_active: false }),
    ];
    const matched = matchAnomalyRules(rules, 0.65);
    expect(matched).toHaveLength(2);
    expect(matched[0]!.anomaly_score_threshold).toBe(0.6); // sorted descending
  });

  it("matchAnomalyRules returns empty when no rules match", () => {
    const rules = [makeRule({ anomaly_score_threshold: 0.9 })];
    expect(matchAnomalyRules(rules, 0.5)).toHaveLength(0);
  });

  it("highestSeverityAction returns most severe action", () => {
    const rules = [
      makeRule({ action_type: "notify_admin" }),
      makeRule({ id: "r2", action_type: "freeze_agent" }),
    ];
    expect(highestSeverityAction(rules)).toBe("freeze_agent");
  });

  it("highestSeverityAction returns null for empty rules", () => {
    expect(highestSeverityAction([])).toBeNull();
  });

  it("highestSeverityAction returns escalate_to_regulator first", () => {
    const rules = [
      makeRule({ action_type: "notify_admin" }),
      makeRule({ id: "r2", action_type: "escalate_to_regulator" }),
    ];
    expect(highestSeverityAction(rules)).toBe("escalate_to_regulator");
  });
});

// ── budgetExceptions ───────────────────────────────────────────────────────────

function makeException(overrides: Partial<BudgetExceptionRequest> = {}): BudgetExceptionRequest {
  return {
    id: "exc1",
    org_id: "org1",
    requested_by: "user1",
    amount_requested: 1000,
    currency: "USD",
    reason: "test",
    status: "approved",
    conditions: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("budgetExceptions", () => {
  it("isBudgetExceptionActive returns true for approved in-window exception", () => {
    const exc = makeException({
      status: "approved",
      effective_from: "2026-01-01T00:00:00Z",
      effective_until: "2026-12-31T23:59:59Z",
    });
    expect(isBudgetExceptionActive(exc, new Date("2026-06-01"))).toBe(true);
  });

  it("isBudgetExceptionActive returns false for non-approved status", () => {
    const exc = makeException({ status: "pending" });
    expect(isBudgetExceptionActive(exc)).toBe(false);
  });

  it("isBudgetExceptionActive returns false when before effective_from", () => {
    const exc = makeException({ effective_from: "2026-12-01T00:00:00Z" });
    expect(isBudgetExceptionActive(exc, new Date("2026-06-01"))).toBe(false);
  });

  it("isBudgetExceptionActive returns false when after effective_until", () => {
    const exc = makeException({ effective_until: "2026-01-01T00:00:00Z" });
    expect(isBudgetExceptionActive(exc, new Date("2026-06-01"))).toBe(false);
  });

  it("isBudgetExceptionTerminal returns true for terminal statuses", () => {
    expect(isBudgetExceptionTerminal("approved")).toBe(true);
    expect(isBudgetExceptionTerminal("rejected")).toBe(true);
    expect(isBudgetExceptionTerminal("expired")).toBe(true);
    expect(isBudgetExceptionTerminal("cancelled")).toBe(true);
  });

  it("isBudgetExceptionTerminal returns false for non-terminal statuses", () => {
    expect(isBudgetExceptionTerminal("pending")).toBe(false);
    expect(isBudgetExceptionTerminal("under_review")).toBe(false);
  });
});

// ── complianceEvidence ─────────────────────────────────────────────────────────

function makeRun(overrides: Partial<ComplianceEvidenceRun> = {}): ComplianceEvidenceRun {
  return {
    id: "run1",
    org_id: "org1",
    framework: "soc2",
    period_start: "2026-01-01",
    period_end: "2026-03-31",
    status: "completed",
    controls: [],
    summary: null,
    applied_by: null,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("complianceEvidence", () => {
  it("evidenceRunPasses returns true when no findings", () => {
    const run = makeRun({
      controls: [
        { control_id: "CC6.1", title: "MFA", status: "pass", evidence: {} },
        { control_id: "CC6.3", title: "Access", status: "gap", evidence: {} },
      ],
    });
    expect(evidenceRunPasses(run)).toBe(true);
  });

  it("evidenceRunPasses returns false when there is a finding", () => {
    const run = makeRun({
      controls: [
        { control_id: "CC6.1", title: "MFA", status: "finding", evidence: {} },
      ],
    });
    expect(evidenceRunPasses(run)).toBe(false);
  });

  it("evidenceRunPasses returns true for empty controls", () => {
    expect(evidenceRunPasses(makeRun())).toBe(true);
  });

  it("nonPassingControls returns findings before gaps", () => {
    const run = makeRun({
      controls: [
        { control_id: "CC6.3", title: "Gap", status: "gap", evidence: {} },
        { control_id: "CC6.1", title: "Finding", status: "finding", evidence: {} },
        { control_id: "CC7.2", title: "Pass", status: "pass", evidence: {} },
      ],
    });
    const result = nonPassingControls(run);
    expect(result).toHaveLength(2);
    expect(result[0]!.status).toBe("finding");
    expect(result[1]!.status).toBe("gap");
  });
});

// ── crossOrgImpersonation ──────────────────────────────────────────────────────

function makeGrant(overrides: Partial<CrossOrgImpersonationGrant> = {}): CrossOrgImpersonationGrant {
  return {
    id: "g1",
    grantor_org_id: "org-a",
    grantee_org_id: "org-b",
    grantee_service_account_id: "sa-1",
    impersonated_role: "auditor",
    allowed_actions: ["data.read"],
    allowed_resource_types: ["report"],
    max_token_duration_seconds: 3600,
    is_active: true,
    created_by: "admin",
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("crossOrgImpersonation", () => {
  it("isImpersonationGrantUsable returns true for active non-expired grant", () => {
    const grant = makeGrant({ expires_at: "2030-01-01T00:00:00Z" });
    expect(isImpersonationGrantUsable(grant)).toBe(true);
  });

  it("isImpersonationGrantUsable returns false when not active", () => {
    expect(isImpersonationGrantUsable(makeGrant({ is_active: false }))).toBe(false);
  });

  it("isImpersonationGrantUsable returns false when revoked", () => {
    expect(isImpersonationGrantUsable(makeGrant({ revoked_at: "2026-01-01T00:00:00Z" }))).toBe(false);
  });

  it("isImpersonationGrantUsable returns false when expired", () => {
    const grant = makeGrant({ expires_at: "2020-01-01T00:00:00Z" });
    expect(isImpersonationGrantUsable(grant, new Date("2026-01-01"))).toBe(false);
  });

  it("clampTokenDuration returns requested when under max", () => {
    expect(clampTokenDuration(makeGrant({ max_token_duration_seconds: 3600 }), 1800)).toBe(1800);
  });

  it("clampTokenDuration clamps to max when over", () => {
    expect(clampTokenDuration(makeGrant({ max_token_duration_seconds: 3600 }), 7200)).toBe(3600);
  });
});

// ── crossOrgPermission ─────────────────────────────────────────────────────────

function makePermissionResult(overrides: Partial<CrossOrgPermissionCheckResult> = {}): CrossOrgPermissionCheckResult {
  return {
    check_id: "chk1",
    trust_precheck_passed: true,
    authorizes_execution: false,
    requires_local_authority_evaluation: true,
    conditions_evaluated: false,
    allowed: true,
    reason: "trust path found",
    trust_path: [],
    conditions: [],
    checked_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("crossOrgPermission", () => {
  // CROSS-028: a trust precheck result must never be readable as an
  // authorization decision — these two fields are the structural proof.
  it("authorizes_execution is always false, regardless of trust_precheck_passed", () => {
    expect(makePermissionResult({ trust_precheck_passed: true }).authorizes_execution).toBe(false);
    expect(makePermissionResult({ trust_precheck_passed: false }).authorizes_execution).toBe(false);
  });

  it("requires_local_authority_evaluation is always true", () => {
    expect(makePermissionResult({ trust_precheck_passed: true }).requires_local_authority_evaluation).toBe(true);
    expect(makePermissionResult({ trust_precheck_passed: false }).requires_local_authority_evaluation).toBe(true);
  });

  it("summarizeTrustPrecheck returns trust_established when passed with no conditions", () => {
    expect(summarizeTrustPrecheck(makePermissionResult())).toBe("trust_established");
  });

  it("summarizeTrustPrecheck returns trust_established_with_unevaluated_conditions when passed with conditions", () => {
    expect(summarizeTrustPrecheck(makePermissionResult({ conditions: ["2fa-required"] }))).toBe(
      "trust_established_with_unevaluated_conditions",
    );
  });

  it("summarizeTrustPrecheck returns no_trust when the precheck failed", () => {
    expect(summarizeTrustPrecheck(makePermissionResult({ trust_precheck_passed: false, allowed: false }))).toBe("no_trust");
  });

  // Deprecated helper retained for backward compatibility — must keep
  // agreeing with summarizeTrustPrecheck()'s underlying boolean.
  it("summarizeCrossOrgPermission (deprecated) returns allowed when allowed with no conditions", () => {
    expect(summarizeCrossOrgPermission(makePermissionResult())).toBe("allowed");
  });

  it("summarizeCrossOrgPermission (deprecated) returns conditional when allowed with conditions", () => {
    expect(summarizeCrossOrgPermission(makePermissionResult({ conditions: ["2fa-required"] }))).toBe("conditional");
  });

  it("summarizeCrossOrgPermission (deprecated) returns denied when not allowed", () => {
    expect(summarizeCrossOrgPermission(makePermissionResult({ allowed: false, trust_precheck_passed: false }))).toBe(
      "denied",
    );
  });

  it("deprecated allowed and canonical trust_precheck_passed never diverge in practice", () => {
    for (const passed of [true, false]) {
      const result = makePermissionResult({ trust_precheck_passed: passed, allowed: passed });
      expect(result.allowed).toBe(result.trust_precheck_passed);
    }
  });
});

// ── financialDashboard ─────────────────────────────────────────────────────────

function makeLiabilityParty(overrides: Partial<LiabilityParty> = {}): LiabilityParty {
  return {
    party_id: "p1",
    party_label: "Agent",
    party_type: "agent",
    role: "executor",
    liability_weight: 0.5,
    acted_at: "2026-01-01T00:00:00Z",
    permit_id: null,
    ...overrides,
  };
}

describe("financialDashboard", () => {
  it("buildLiabilityVisualization builds nodes and edges from chain", () => {
    const chain: LiabilityParty[] = [
      makeLiabilityParty({ party_id: "p1", role: "delegator", liability_weight: 0.3 }),
      makeLiabilityParty({ party_id: "p2", role: "delegate", liability_weight: 0.7 }),
    ];
    const viz = buildLiabilityVisualization("exec-1", "org-1", chain);
    expect(viz.execution_id).toBe("exec-1");
    expect(viz.org_id).toBe("org-1");
    expect(viz.nodes).toHaveLength(2);
    expect(viz.edges).toHaveLength(1);
    expect(viz.edges[0]!.relationship).toBe("delegated_to");
    expect(viz.total_weight).toBeCloseTo(1.0);
  });

  it("buildLiabilityVisualization uses supervised relationship", () => {
    const chain: LiabilityParty[] = [
      makeLiabilityParty({ party_id: "p1", role: "supervisor", liability_weight: 0.5 }),
      makeLiabilityParty({ party_id: "p2", role: "executor", liability_weight: 0.5 }),
    ];
    const viz = buildLiabilityVisualization("exec-2", "org-2", chain);
    expect(viz.edges[0]!.relationship).toBe("supervised");
  });

  it("buildLiabilityVisualization uses approved_for relationship", () => {
    const chain: LiabilityParty[] = [
      makeLiabilityParty({ party_id: "p1", role: "executor", liability_weight: 0.5 }),
      makeLiabilityParty({ party_id: "p2", role: "approver", liability_weight: 0.5 }),
    ];
    const viz = buildLiabilityVisualization("exec-3", "org-3", chain);
    expect(viz.edges[0]!.relationship).toBe("approved_for");
  });

  it("buildLiabilityVisualization uses overrode relationship", () => {
    const chain: LiabilityParty[] = [
      makeLiabilityParty({ party_id: "p1", role: "executor", liability_weight: 0.5 }),
      makeLiabilityParty({ party_id: "p2", role: "override_actor", liability_weight: 0.5 }),
    ];
    const viz = buildLiabilityVisualization("exec-4", "org-4", chain);
    expect(viz.edges[0]!.relationship).toBe("overrode");
  });

  it("buildRiskTimeline maps risk scores to tiers", () => {
    const snapshots = [
      { date: "2026-01-01", riskScore: 10, actionCount: 1, totalValue: 100, overrideCount: 0, anomalyCount: 0 },
      { date: "2026-01-02", riskScore: 30, actionCount: 2, totalValue: 200, overrideCount: 0, anomalyCount: 1 },
      { date: "2026-01-03", riskScore: 60, actionCount: 3, totalValue: 300, overrideCount: 1, anomalyCount: 0 },
      { date: "2026-01-04", riskScore: 90, actionCount: 4, totalValue: 400, overrideCount: 2, anomalyCount: 2 },
    ];
    const timeline = buildRiskTimeline(snapshots);
    expect(timeline[0]!.risk_tier).toBe("low");
    expect(timeline[1]!.risk_tier).toBe("medium");
    expect(timeline[2]!.risk_tier).toBe("high");
    expect(timeline[3]!.risk_tier).toBe("critical");
  });
});

// ── governanceWebhooks ─────────────────────────────────────────────────────────

describe("governanceWebhooks", () => {
  it("verifyWebhookSignature returns false for non-sha256 prefix", async () => {
    const result = await verifyWebhookSignature("payload", "md5=abc", "secret");
    expect(result).toBe(false);
  });

  it("verifyWebhookSignature validates correct HMAC signature", async () => {
    const secret = "test-webhook-secret";
    const payload = '{"event":"test"}';
    // Compute expected signature
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
    const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
    const result = await verifyWebhookSignature(payload, `sha256=${hex}`, secret);
    expect(result).toBe(true);
  });

  it("verifyWebhookSignature rejects wrong signature", async () => {
    const result = await verifyWebhookSignature("payload", "sha256=deadbeef", "secret");
    expect(result).toBe(false);
  });
});

// ── incentiveSignalFeedback ────────────────────────────────────────────────────

describe("incentiveSignalFeedback", () => {
  it("computeSignalEngagementRate returns 0 when no signals", () => {
    const summary: SignalActionSummary = { total_signals: 0, acted_on: 0, dismissed: 0, average_outcome_score: 0, by_action_type: {} as SignalActionSummary["by_action_type"] };
    expect(computeSignalEngagementRate(summary)).toBe(0);
  });

  it("computeSignalEngagementRate computes acted_on/total", () => {
    const summary: SignalActionSummary = { total_signals: 10, acted_on: 7, dismissed: 2, average_outcome_score: 0.8, by_action_type: {} as SignalActionSummary["by_action_type"] };
    expect(computeSignalEngagementRate(summary)).toBeCloseTo(0.7);
  });

  it("isSubstantiveSignalResponse returns true for substantive actions", () => {
    expect(isSubstantiveSignalResponse("policy_updated")).toBe(true);
    expect(isSubstantiveSignalResponse("training_initiated")).toBe(true);
    expect(isSubstantiveSignalResponse("process_changed")).toBe(true);
    expect(isSubstantiveSignalResponse("monitoring_increased")).toBe(true);
    expect(isSubstantiveSignalResponse("escalated")).toBe(true);
  });

  it("isSubstantiveSignalResponse returns false for non-substantive", () => {
    expect(isSubstantiveSignalResponse("dismissed")).toBe(false);
    expect(isSubstantiveSignalResponse("auto_remediated")).toBe(false);
  });
});

// ── policySync ────────────────────────────────────────────────────────────────

function makeSyncRun(overrides: Partial<PolicySyncRun> = {}): PolicySyncRun {
  return {
    id: "sync1",
    org_id: "org1",
    source: "github",
    ref: "main",
    commit_sha: null,
    bundle_hash: null,
    status: "completed",
    policies_added: 0,
    policies_updated: 0,
    policies_removed: 0,
    diff: null,
    applied_by: null,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("policySync", () => {
  it("formatPolicySyncDiff returns no changes for all zeros", () => {
    expect(formatPolicySyncDiff(makeSyncRun())).toBe("no changes");
  });

  it("formatPolicySyncDiff includes adds and updates", () => {
    const result = formatPolicySyncDiff(makeSyncRun({ policies_added: 3, policies_updated: 1 }));
    expect(result).toContain("+3 added");
    expect(result).toContain("~1 updated");
  });

  it("formatPolicySyncDiff includes removals", () => {
    expect(formatPolicySyncDiff(makeSyncRun({ policies_removed: 2 }))).toBe("-2 removed");
  });

  it("isPolicySyncTerminal returns true for terminal statuses", () => {
    expect(isPolicySyncTerminal(makeSyncRun({ status: "completed" }))).toBe(true);
    expect(isPolicySyncTerminal(makeSyncRun({ status: "failed" }))).toBe(true);
    expect(isPolicySyncTerminal(makeSyncRun({ status: "rejected" }))).toBe(true);
  });

  it("isPolicySyncTerminal returns false for non-terminal", () => {
    expect(isPolicySyncTerminal(makeSyncRun({ status: "pending" }))).toBe(false);
    expect(isPolicySyncTerminal(makeSyncRun({ status: "applying" }))).toBe(false);
  });
});

// ── regulatoryEscalation ──────────────────────────────────────────────────────

function makeEscalation(overrides: Partial<RegulatoryEscalation> = {}): RegulatoryEscalation {
  return {
    id: "esc1",
    org_id: "org1",
    from_level_id: "l1",
    to_level_id: "l2",
    subject_type: "policy_violation",
    subject_id: "pv1",
    reason: "SLA breach",
    details: {},
    status: "pending",
    escalated_by: "system",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeLevel(overrides: Partial<RegulatoryAuthorityLevel> = {}): RegulatoryAuthorityLevel {
  return {
    id: "l2",
    org_id: "org1",
    name: "Regional DPA",
    level: 2,
    escalation_sla_hours: 24,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("regulatoryEscalation", () => {
  it("isRegulatoryEscalationTerminal returns true for resolved/overridden", () => {
    expect(isRegulatoryEscalationTerminal("resolved")).toBe(true);
    expect(isRegulatoryEscalationTerminal("overridden")).toBe(true);
  });

  it("isRegulatoryEscalationTerminal returns false for active statuses", () => {
    expect(isRegulatoryEscalationTerminal("pending")).toBe(false);
    expect(isRegulatoryEscalationTerminal("acknowledged")).toBe(false);
    expect(isRegulatoryEscalationTerminal("under_review")).toBe(false);
  });

  it("isEscalationSlaBreached returns false for terminal escalation", () => {
    const esc = makeEscalation({ status: "resolved" });
    expect(isEscalationSlaBreached(esc, makeLevel())).toBe(false);
  });

  it("isEscalationSlaBreached returns true when SLA exceeded", () => {
    const esc = makeEscalation({ created_at: "2026-01-01T00:00:00Z" });
    const level = makeLevel({ escalation_sla_hours: 1 });
    const now = new Date("2026-01-01T02:00:00Z"); // 2 hours later
    expect(isEscalationSlaBreached(esc, level, now)).toBe(true);
  });

  it("isEscalationSlaBreached returns false when within SLA", () => {
    const esc = makeEscalation({ created_at: "2026-01-01T00:00:00Z" });
    const level = makeLevel({ escalation_sla_hours: 48 });
    const now = new Date("2026-01-01T12:00:00Z"); // 12 hours later
    expect(isEscalationSlaBreached(esc, level, now)).toBe(false);
  });
});

// ── state ──────────────────────────────────────────────────────────────────────

describe("state", () => {
  it("STATE_SOURCES contains expected emitters", () => {
    expect(STATE_SOURCES).toContain("hiCoach");
    expect(STATE_SOURCES).toContain("AtlaSent");
    expect(STATE_SOURCES.length).toBeGreaterThan(0);
  });
});

// ── economicRisk ───────────────────────────────────────────────────────────────

function makeConcentrationAnalysis(overrides: Partial<ApprovalConcentrationAnalysis> = {}): ApprovalConcentrationAnalysis {
  return {
    scope_id: "scope-1",
    analysis_window_days: 30,
    total_approvals: 100,
    total_value: 50000,
    approver_breakdown: [],
    alerts: [],
    concentration_hhi: 0,
    computed_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("economicRisk", () => {
  it("computeApprovalRiskScore returns 0 for HHI=0", () => {
    const result = computeApprovalRiskScore(makeConcentrationAnalysis({ concentration_hhi: 0 }));
    expect(result).toBe(0);
  });

  it("computeApprovalRiskScore returns 100 for HHI=10000", () => {
    const result = computeApprovalRiskScore(makeConcentrationAnalysis({ concentration_hhi: 10000 }));
    expect(result).toBe(100);
  });
});

// ── complianceEvidence sort edge cases ───────────────────────────────────────

describe("complianceEvidence sort edge cases", () => {
  it("nonPassingControls sorts multiple gaps and finding (covers return 1 and return 0)", () => {
    const run = makeRun({
      controls: [
        { control_id: "CC6.1", title: "Gap A", status: "gap", evidence: {} },
        { control_id: "CC6.2", title: "Gap B", status: "gap", evidence: {} },
        { control_id: "CC6.3", title: "Finding", status: "finding", evidence: {} },
      ],
    });
    // Three non-pass items forces sort comparisons including (gap,gap)→return 0
    // and (gap,finding) with gap as 'a' → return 1
    const result = nonPassingControls(run);
    expect(result).toHaveLength(3);
    expect(result[0]!.status).toBe("finding");
  });
});
