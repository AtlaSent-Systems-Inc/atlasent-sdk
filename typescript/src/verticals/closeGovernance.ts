import { protectOrEscalate } from "../approvalRuntime.js";
import { buildActionContext, flattenActionContext } from "../actionContext.js";
import type { ApprovalPermit } from "../approvalRuntime.js";
import type { EscalationHandle } from "../approvalRuntime.js";

export type CloseActionType = "period.close" | "period.reopen" | "data.export" | "reconciliation.lock";

export interface CloseGovernanceOptions {
  action: CloseActionType;
  periodLabel: string;
  closedBy: string;
  entityId: string;
  entityName?: string;
  dataClassification?: "internal" | "confidential" | "restricted";
  assignedToRole?: string;
  requireDualApproval?: boolean;
  waitMs?: number;
  description?: string;
  onEscalationCreated?: (handle: EscalationHandle) => void;
  apiKey?: string;
  baseUrl?: string;
}

const ACTION_RISK: Record<CloseActionType, "critical" | "high" | "medium" | "low"> = {
  "period.close": "critical",
  "period.reopen": "critical",
  "reconciliation.lock": "high",
  "data.export": "high",
};

const ACTION_REVERSIBILITY: Record<CloseActionType, "reversible" | "irreversible" | "partial"> = {
  "period.close": "partial",
  "period.reopen": "partial",
  "reconciliation.lock": "reversible",
  "data.export": "irreversible",
};

export async function protectCloseAction(
  opts: CloseGovernanceOptions,
): Promise<ApprovalPermit> {
  const ctx = buildActionContext({
    actor: {
      id: opts.closedBy,
      type: "human",
      trust_level: "medium",
    },
    resource: {
      id: opts.entityId,
      type: "accounting_entity",
      sensitivity: opts.dataClassification ?? "confidential",
      ...(opts.entityName !== undefined ? { name: opts.entityName } : {}),
    },
    environment: "production",
    action_meta: {
      risk_level: ACTION_RISK[opts.action],
      reversibility: ACTION_REVERSIBILITY[opts.action],
      description: opts.description ?? `${opts.action} for period ${opts.periodLabel} on entity ${opts.entityId}`,
    },
    extra: {
      period_label: opts.periodLabel,
      close_action: opts.action,
    },
  });

  return protectOrEscalate(
    {
      action: opts.action,
      agent: opts.closedBy,
      context: flattenActionContext(ctx),
    },
    {
      escalationReason: `Accounting ${opts.action} for period '${opts.periodLabel}' requires approval`,
      assignedToRole: opts.assignedToRole ?? "controller",
      quorumRequired: (opts.requireDualApproval ?? opts.action === "period.close") ? "simple_majority" : "single_approver",
      waitMs: opts.waitMs ?? 24 * 60 * 60 * 1000,
      ...(opts.onEscalationCreated !== undefined ? { onEscalationCreated: opts.onEscalationCreated } : {}),
      ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
      ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
    },
  );
}
