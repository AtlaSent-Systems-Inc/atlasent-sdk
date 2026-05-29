import { protectOrEscalate } from "../approvalRuntime.js";
import { buildActionContext, flattenActionContext } from "../actionContext.js";
import type { ApprovalPermit } from "../approvalRuntime.js";
import type { EscalationHandle } from "../approvalRuntime.js";

export type FinancialCloseActionType = "period.close.certify";

const FINANCIAL_CLOSE_ACTION_RISK: Record<
  FinancialCloseActionType,
  "critical"
> = {
  "period.close.certify": "critical",
};

// period.close.certify is non-machine-executable and fail-closed.
const MACHINE_EXECUTABLE_ACTIONS = new Set<FinancialCloseActionType>();

export interface FinancialCloseOptions {
  action: FinancialCloseActionType;
  periodId: string;
  certifiedBy: string;
  financialController: string;
  onEscalationCreated?: (handle: EscalationHandle) => void;
  apiKey?: string;
  baseUrl?: string;
}

export async function protectFinancialCloseAction(
  opts: FinancialCloseOptions,
): Promise<ApprovalPermit> {
  if (!opts.periodId) {
    throw new TypeError(
      `Financial close action 'period.close.certify' requires 'periodId'`,
    );
  }
  if (!opts.certifiedBy) {
    throw new TypeError(
      `Financial close action 'period.close.certify' requires 'certifiedBy'`,
    );
  }
  if (!opts.financialController) {
    throw new TypeError(
      `Financial close action 'period.close.certify' requires 'financialController'`,
    );
  }

  const riskLevel = FINANCIAL_CLOSE_ACTION_RISK[opts.action];

  const ctx = buildActionContext({
    actor: {
      id: opts.certifiedBy,
      type: "human",
    },
    resource: {
      id: opts.periodId,
      type: "financial_period",
      sensitivity: "restricted",
    },
    environment: "production",
    action_meta: {
      risk_level: riskLevel,
      reversibility: "irreversible",
      description: `Financial close action '${opts.action}' for period '${opts.periodId}'`,
    },
    extra: {
      financial_close_action: opts.action,
      machine_executable: false,
      fail_closed: true,
      period_id: opts.periodId,
      certified_by: opts.certifiedBy,
      financial_controller: opts.financialController,
    },
  });

  const request = {
    action: opts.action,
    agent: opts.certifiedBy,
    context: flattenActionContext(ctx),
  };

  return protectOrEscalate(request, {
    escalationReason: `Financial close action '${opts.action}' for period '${opts.periodId}' requires human review (machine_executable: false, fail_closed: true)`,
    assignedToRole: "financial-controller",
    quorumRequired: "simple_majority",
    waitMs: 172_800_000,
    ...(opts.onEscalationCreated !== undefined
      ? { onEscalationCreated: opts.onEscalationCreated }
      : {}),
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
  });
}

export async function protectPeriodCloseCertify(
  opts: Omit<FinancialCloseOptions, "action">,
): Promise<ApprovalPermit> {
  return protectFinancialCloseAction({
    ...opts,
    action: "period.close.certify",
  });
}
