import { protectOrEscalate } from "../approvalRuntime.js";
import { buildActionContext, flattenActionContext } from "../actionContext.js";
import type { ApprovalPermit } from "../approvalRuntime.js";
import type { EscalationHandle } from "../approvalRuntime.js";

export type ModelGovernanceActionType =
  | "ml.model.promote"
  | "ml.model.retire"
  | "ml.model.fine_tune";

const MODEL_ACTION_RISK: Record<ModelGovernanceActionType, "critical" | "high"> = {
  "ml.model.promote": "critical",
  "ml.model.retire": "high",
  "ml.model.fine_tune": "high",
};

export interface ModelGovernanceOptions {
  action: ModelGovernanceActionType;
  modelId: string;
  authorizedBy: string;
  reason: string;
  safetyReviewId?: string;
  serviceImpactAssessed?: boolean;
  alignmentVerified?: boolean;
  targetEnvironment?: string;
  assignedToRole?: string;
  waitMs?: number;
  onEscalationCreated?: (handle: EscalationHandle) => void;
  apiKey?: string;
  baseUrl?: string;
}

export async function protectModelGovernance(
  opts: ModelGovernanceOptions,
): Promise<ApprovalPermit> {
  const riskLevel = MODEL_ACTION_RISK[opts.action] ?? "high";

  const ctx = buildActionContext({
    actor: {
      id: opts.authorizedBy,
      type: "human",
    },
    resource: {
      id: opts.modelId,
      type: "ml_model",
      sensitivity: "restricted",
    },
    environment: "production",
    action_meta: {
      risk_level: riskLevel,
      reversibility: opts.action === "ml.model.retire" ? "irreversible" : "reversible",
      description: `Model governance action '${opts.action}' on model '${opts.modelId}': ${opts.reason}`,
    },
    extra: {
      model_action: opts.action,
      machine_executable: false,
      fail_closed: true,
      reason: opts.reason,
      ...(opts.safetyReviewId !== undefined ? { safety_review_id: opts.safetyReviewId } : {}),
      ...(opts.serviceImpactAssessed !== undefined ? { service_impact_assessed: opts.serviceImpactAssessed } : {}),
      ...(opts.alignmentVerified !== undefined ? { alignment_verified: opts.alignmentVerified } : {}),
      ...(opts.targetEnvironment !== undefined ? { target_environment: opts.targetEnvironment } : {}),
    },
  });

  return protectOrEscalate(
    {
      action: opts.action,
      agent: opts.authorizedBy,
      context: flattenActionContext(ctx),
    },
    {
      escalationReason: `Model governance action '${opts.action}' on '${opts.modelId}' requires human review — machine_executable: false`,
      assignedToRole: opts.assignedToRole ?? (riskLevel === "critical" ? "ml-safety-director" : "ml-reviewer"),
      quorumRequired: riskLevel === "critical" ? "simple_majority" : "single_approver",
      waitMs: opts.waitMs ?? 48 * 60 * 60 * 1000,
      ...(opts.onEscalationCreated !== undefined ? { onEscalationCreated: opts.onEscalationCreated } : {}),
      ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
      ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
    },
  );
}

export async function protectModelPromotion(
  opts: Omit<ModelGovernanceOptions, "action">,
): Promise<ApprovalPermit> {
  return protectModelGovernance({ ...opts, action: "ml.model.promote" });
}
