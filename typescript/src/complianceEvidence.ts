/**
 * Compliance evidence types — wire shapes for `v1-compliance-evidence`.
 *
 * Supports on-demand SOC 2 Type II control evidence collection. The
 * same run shape is used for ISO 27001, GDPR, and HIPAA; control IDs
 * differ per framework.
 */

export type ComplianceFramework = "soc2" | "iso27001" | "gdpr" | "hipaa";

export type EvidenceControlStatus = "pass" | "gap" | "finding";

export type ComplianceRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed";

/**
 * A single evaluated control within an evidence run.
 * `evidence` is a free-form object whose keys are framework-specific
 * metric names (e.g. `mfa_enforced_policies`, `audit_events_last_30d`).
 */
export interface EvidenceControl {
  control_id: string;
  title: string;
  status: EvidenceControlStatus;
  evidence: Record<string, unknown>;
}

export interface ComplianceEvidenceSummary {
  total: number;
  pass: number;
  gap: number;
  finding: number;
}

export interface ComplianceEvidenceRun {
  id: string;
  org_id: string;
  framework: ComplianceFramework;
  period_start: string;
  period_end: string;
  status: ComplianceRunStatus;
  controls: EvidenceControl[];
  summary: ComplianceEvidenceSummary | null;
  applied_by: string | null;
  created_at: string;
}

export interface TriggerEvidenceRunRequest {
  framework: ComplianceFramework;
  /** ISO 8601 date string; defaults to 30 days ago on the server. */
  period_start?: string;
  /** ISO 8601 date string; defaults to now on the server. */
  period_end?: string;
}

export interface TriggerEvidenceRunResponse {
  run: ComplianceEvidenceRun;
}

export interface ListEvidenceRunsResponse {
  runs: ComplianceEvidenceRun[];
}

/**
 * SOC 2 control IDs evaluated by `v1-compliance-evidence`.
 *
 * | ID     | Area |
 * |--------|------|
 * | CC6.1  | MFA enforcement |
 * | CC6.3  | Periodic access reviews |
 * | CC7.2  | Audit trail completeness |
 * | CC8.1  | Change management / HITL |
 * | CC3.2  | Policy violations |
 */
export type SOC2ControlId = "CC6.1" | "CC6.3" | "CC7.2" | "CC8.1" | "CC3.2";

/**
 * Returns `true` when every control in the run has `pass` or `gap`
 * status (no `finding`). A `gap` means a control is partially met;
 * a `finding` is a blocking deficiency that requires remediation.
 */
export function evidenceRunPasses(run: ComplianceEvidenceRun): boolean {
  return (run.controls ?? []).every(c => c.status !== "finding");
}

/**
 * Returns controls that do not have `pass` status, sorted so
 * `finding` controls appear before `gap` controls.
 */
export function nonPassingControls(run: ComplianceEvidenceRun): EvidenceControl[] {
  return (run.controls ?? [])
    .filter(c => c.status !== "pass")
    .sort((a, b) => {
      if (a.status === "finding" && b.status !== "finding") return -1;
      if (b.status === "finding" && a.status !== "finding") return 1;
      return 0;
    });
}
