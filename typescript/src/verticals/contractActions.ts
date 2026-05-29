import { protectOrEscalate } from "../approvalRuntime.js";
import { buildActionContext, flattenActionContext } from "../actionContext.js";
import type { ApprovalPermit } from "../approvalRuntime.js";
import type { EscalationHandle } from "../approvalRuntime.js";

export type ContractActionType =
  | "contract.execute"
  | "contract.amend";

const CONTRACT_ACTION_RISK: Record<ContractActionType, "critical" | "high"> = {
  "contract.execute": "critical",
  "contract.amend": "high",
};

export interface ContractActionOptions {
  action: ContractActionType;
  contractId: string;
  authorizedBy: string;
  counterparty: string;
  legalReviewId?: string;
  estimatedValue?: number;
  currency?: string;
  effectiveDate?: string;
  amendmentDescription?: string;
  assignedToRole?: string;
  waitMs?: number;
  onEscalationCreated?: (handle: EscalationHandle) => void;
  apiKey?: string;
  baseUrl?: string;
}

export async function protectContractAction(
  opts: ContractActionOptions,
): Promise<ApprovalPermit> {
  if (opts.action === "contract.amend" && !opts.amendmentDescription) {
    throw new TypeError(
      `Contract action 'contract.amend' requires 'amendmentDescription'`,
    );
  }

  const riskLevel = CONTRACT_ACTION_RISK[opts.action] ?? "high";

  const ctx = buildActionContext({
    actor: {
      id: opts.authorizedBy,
      type: "human",
    },
    resource: {
      id: opts.contractId,
      type: "contract",
      sensitivity: "restricted",
    },
    environment: "production",
    action_meta: {
      risk_level: riskLevel,
      reversibility: opts.action === "contract.execute" ? "irreversible" : "partial",
      description: `Contract action '${opts.action}' on contract '${opts.contractId}' with counterparty '${opts.counterparty}'`,
      ...(opts.estimatedValue !== undefined ? { estimated_amount: opts.estimatedValue } : {}),
      ...(opts.currency !== undefined ? { currency: opts.currency } : {}),
    },
    extra: {
      contract_action: opts.action,
      machine_executable: false,
      fail_closed: true,
      counterparty: opts.counterparty,
      ...(opts.legalReviewId !== undefined ? { legal_review_id: opts.legalReviewId } : {}),
      ...(opts.effectiveDate !== undefined ? { effective_date: opts.effectiveDate } : {}),
      ...(opts.amendmentDescription !== undefined ? { amendment_description: opts.amendmentDescription } : {}),
    },
  });

  return protectOrEscalate(
    {
      action: opts.action,
      agent: opts.authorizedBy,
      context: flattenActionContext(ctx),
    },
    {
      escalationReason: `Contract action '${opts.action}' on '${opts.contractId}' requires legal review — machine_executable: false`,
      assignedToRole: opts.assignedToRole ?? (riskLevel === "critical" ? "legal-director" : "legal-reviewer"),
      quorumRequired: riskLevel === "critical" ? "simple_majority" : "single_approver",
      waitMs: opts.waitMs ?? 48 * 60 * 60 * 1000,
      ...(opts.onEscalationCreated !== undefined ? { onEscalationCreated: opts.onEscalationCreated } : {}),
      ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
      ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
    },
  );
}

export async function protectContractExecution(
  opts: Omit<ContractActionOptions, "action">,
): Promise<ApprovalPermit> {
  return protectContractAction({ ...opts, action: "contract.execute" });
}
