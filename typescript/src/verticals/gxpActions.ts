import { protectOrEscalate } from "../approvalRuntime.js";
import { buildActionContext, flattenActionContext } from "../actionContext.js";
import type { ApprovalPermit } from "../approvalRuntime.js";
import type { EscalationHandle } from "../approvalRuntime.js";

export type GxpActionType =
  | "manufacturing.batch_record.release"
  // AC-001 Deploy — validated system deployment (validated-state semantics; AI-agent excluded)
  | "gxp.system.deploy"
  // AC-020 Certify — QP batch release (personal, non-delegatable qualified authority)
  | "manufacturing.qp.certify"
  | "clinical.tmf.record.modify"
  | "clinical.data.access"
  | "clinical.source_data.read"
  | "clinical.signature.apply"
  | "clinical.deviation.report"
  | "clinical.consent.update"
  | "quality.capa.initiate"
  | "quality.capa.assign"
  | "quality.capa.progress"
  | "quality.capa.effectiveness_check"
  | "quality.capa.close"
  | "quality.deviation.detect"
  | "quality.deviation.classify"
  | "quality.deviation.escalate"
  | "quality.deviation.investigate"
  | "quality.deviation.close"
  | "quality.change_control.initiate"
  | "quality.change_control.classify"
  | "quality.change_control.approve"
  | "quality.change_control.implement"
  | "quality.change_control.close";

const GXP_ACTION_RISK: Record<GxpActionType, "high" | "critical"> = {
  "manufacturing.batch_record.release": "critical",
  "gxp.system.deploy": "critical",
  "manufacturing.qp.certify": "critical",
  "clinical.tmf.record.modify": "high",
  "clinical.data.access": "high",
  "clinical.source_data.read": "high",
  "clinical.signature.apply": "high",
  "clinical.deviation.report": "high",
  "clinical.consent.update": "high",
  "quality.capa.initiate": "high",
  "quality.capa.assign": "high",
  "quality.capa.progress": "high",
  "quality.capa.effectiveness_check": "high",
  "quality.capa.close": "high",
  "quality.deviation.detect": "high",
  "quality.deviation.classify": "high",
  "quality.deviation.escalate": "high",
  "quality.deviation.investigate": "high",
  "quality.deviation.close": "high",
  "quality.change_control.initiate": "high",
  "quality.change_control.classify": "high",
  "quality.change_control.approve": "high",
  "quality.change_control.implement": "high",
  "quality.change_control.close": "high",
};

export interface BatchRecordReleaseOptions {
  batchId: string;
  productCode: string;
  lotNumber: string;
  certifiedBy: string;
  qaSignoffBy: string;
  batchRecordComplete: boolean;
  deviationCount: number;
  regulatoryRegion: string;
  action: "manufacturing.batch_record.release";
  assignedToRole?: string;
  waitMs?: number;
  onEscalationCreated?: (handle: EscalationHandle) => void;
  apiKey?: string;
  baseUrl?: string;
}

export interface ClinicalDataAccessOptions {
  subjectId: string;
  dataCategory: string;
  accessedBy: string;
  purpose: string;
  aiAgent: boolean;
  consentVerified: boolean;
  trialId: string;
  action: "clinical.data.access";
  assignedToRole?: string;
  waitMs?: number;
  onEscalationCreated?: (handle: EscalationHandle) => void;
  apiKey?: string;
  baseUrl?: string;
}

export interface CAPAOptions {
  capaId: string;
  action: GxpActionType & `quality.capa.${string}`;
  initiatedBy?: string;
  closedBy?: string;
  secondClosedBy?: string;
  severity?: "minor" | "major" | "critical";
  assignedToRole?: string;
  waitMs?: number;
  onEscalationCreated?: (handle: EscalationHandle) => void;
  apiKey?: string;
  baseUrl?: string;
  [key: string]: unknown;
}

export type GxpActionOptions =
  | BatchRecordReleaseOptions
  | ClinicalDataAccessOptions
  | CAPAOptions
  | { action: GxpActionType; assignedToRole?: string; waitMs?: number; onEscalationCreated?: (handle: EscalationHandle) => void; apiKey?: string; baseUrl?: string; [key: string]: unknown };

export async function protectGxpAction(
  opts: GxpActionOptions,
): Promise<ApprovalPermit> {
  const action = opts.action as GxpActionType;
  const riskLevel = GXP_ACTION_RISK[action] ?? "high";

  const actorId =
    ("certifiedBy" in opts && opts.certifiedBy) ||
    ("accessedBy" in opts && opts.accessedBy) ||
    ("initiatedBy" in opts && opts.initiatedBy) ||
    ("closedBy" in opts && opts.closedBy) ||
    "gxp-agent";

  const resourceId =
    ("batchId" in opts && opts.batchId) ||
    ("capaId" in opts && opts.capaId) ||
    ("subjectId" in opts && opts.subjectId) ||
    action;

  const ctx = buildActionContext({
    actor: {
      id: actorId as string,
      type: "human",
    },
    resource: {
      id: resourceId as string,
      type: "gxp_record",
      sensitivity: "restricted",
    },
    environment: "production",
    action_meta: {
      risk_level: riskLevel,
      reversibility: "irreversible",
      description: `GxP action '${action}' on resource '${resourceId}'`,
    },
    extra: {
      gxp_action: action,
      machine_executable: false,
      fail_closed: true,
      ...Object.fromEntries(
        Object.entries(opts).filter(([k]) => !["action", "assignedToRole", "waitMs", "onEscalationCreated", "apiKey", "baseUrl"].includes(k)),
      ),
    },
  });

  return protectOrEscalate(
    {
      action,
      agent: actorId as string,
      context: flattenActionContext(ctx),
    },
    {
      escalationReason: `GxP action '${action}' requires human review — machine_executable: false`,
      assignedToRole: opts.assignedToRole ?? (riskLevel === "critical" ? "qa-director" : "qa-reviewer"),
      quorumRequired: action === "quality.capa.close" || action === "manufacturing.batch_record.release" ? "simple_majority" : "single_approver",
      waitMs: opts.waitMs ?? 24 * 60 * 60 * 1000,
      ...(opts.onEscalationCreated !== undefined ? { onEscalationCreated: opts.onEscalationCreated } : {}),
      ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
      ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
    },
  );
}

export async function protectBatchRecordRelease(
  opts: Omit<BatchRecordReleaseOptions, "action">,
): Promise<ApprovalPermit> {
  return protectGxpAction({ ...opts, action: "manufacturing.batch_record.release" });
}
