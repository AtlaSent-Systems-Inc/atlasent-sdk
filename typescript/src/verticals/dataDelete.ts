import { protectOrEscalate } from "../approvalRuntime.js";
import { buildActionContext, flattenActionContext } from "../actionContext.js";
import type { ApprovalPermit } from "../approvalRuntime.js";
import type { EscalationHandle } from "../approvalRuntime.js";

export type DataDeleteActionType = "customer.data.delete";

export type GdprLegalBasis =
  | "erasure_request"
  | "retention_expired"
  | "consent_withdrawn"
  | "controller_instruction";

export interface DataDeleteOptions {
  action: DataDeleteActionType;
  dataSubjectId: string;
  verifiedBy: string;
  gdprBasis: GdprLegalBasis;
  dpaReference?: string;
  dataCategories?: string[];
  retentionEndDate?: string;
  assignedToRole?: string;
  waitMs?: number;
  onEscalationCreated?: (handle: EscalationHandle) => void;
  apiKey?: string;
  baseUrl?: string;
}

export async function protectCustomerDataDelete(
  opts: DataDeleteOptions,
): Promise<ApprovalPermit> {
  const ctx = buildActionContext({
    actor: {
      id: opts.verifiedBy,
      type: "human",
    },
    resource: {
      id: opts.dataSubjectId,
      type: "customer_data",
      sensitivity: "restricted",
    },
    environment: "production",
    action_meta: {
      risk_level: "critical",
      reversibility: "irreversible",
      description: `Customer data deletion for data subject '${opts.dataSubjectId}' under GDPR/CCPA basis '${opts.gdprBasis}'`,
    },
    extra: {
      data_delete_action: opts.action,
      machine_executable: false,
      fail_closed: true,
      gdpr_basis: opts.gdprBasis,
      verified_by: opts.verifiedBy,
      data_subject_id: opts.dataSubjectId,
      ...(opts.dpaReference !== undefined ? { dpa_reference: opts.dpaReference } : {}),
      ...(opts.dataCategories !== undefined ? { data_categories: opts.dataCategories } : {}),
      ...(opts.retentionEndDate !== undefined ? { retention_end_date: opts.retentionEndDate } : {}),
    },
  });

  return protectOrEscalate(
    {
      action: opts.action,
      agent: opts.verifiedBy,
      context: flattenActionContext(ctx),
    },
    {
      escalationReason: `Customer data deletion for '${opts.dataSubjectId}' is irreversible and requires compliance officer sign-off — machine_executable: false, fail_closed: true`,
      assignedToRole: opts.assignedToRole ?? "compliance-officer",
      quorumRequired: "simple_majority",
      waitMs: opts.waitMs ?? 72 * 60 * 60 * 1000,
      ...(opts.onEscalationCreated !== undefined ? { onEscalationCreated: opts.onEscalationCreated } : {}),
      ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
      ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
    },
  );
}
