import { protectOrEscalate } from "../approvalRuntime.js";
import { protect } from "../protect.js";
import { buildActionContext, flattenActionContext } from "../actionContext.js";
import type { ApprovalPermit } from "../approvalRuntime.js";
import type { Permit } from "../protect.js";
import type { EscalationHandle } from "../approvalRuntime.js";

export type PaymentOperationActionType =
  | "payment.approval.approve"
  | "payment.approval.deny"
  | "payment.execute.approved"
  | "payment.execute.held"
  | "payment.execute.denied"
  | "payment.execute.policy_error"
  | "qb.transaction.approve";

const PAYMENT_ACTION_RISK: Record<PaymentOperationActionType, "critical" | "high" | "medium"> = {
  "payment.approval.approve": "high",
  "payment.approval.deny": "medium",
  "payment.execute.approved": "critical",
  "payment.execute.held": "high",
  "payment.execute.denied": "medium",
  "payment.execute.policy_error": "high",
  "qb.transaction.approve": "high",
};

const ESCALATE_ACTIONS = new Set<PaymentOperationActionType>([
  "payment.approval.approve",
  "payment.execute.approved",
  "payment.execute.held",
  "payment.execute.policy_error",
  "qb.transaction.approve",
]);

export interface PaymentOperationOptions {
  paymentId: string;
  action: PaymentOperationActionType;
  amount?: number;
  currency?: string;
  approvedBy?: string;
  deniedBy?: string;
  executedBy?: string;
  heldBy?: string;
  holdReason?: string;
  policyRule?: string;
  errorCode?: string;
  bankReference?: string;
  invoiceId?: string;
  vendorId?: string;
  accountCode?: string;
  transactionId?: string;
  assignedToRole?: string;
  waitMs?: number;
  onEscalationCreated?: (handle: EscalationHandle) => void;
  apiKey?: string;
  baseUrl?: string;
}

export async function protectPaymentOperation(
  opts: PaymentOperationOptions,
): Promise<ApprovalPermit | Permit> {
  const riskLevel = PAYMENT_ACTION_RISK[opts.action] ?? "high";

  const actorId =
    opts.approvedBy ??
    opts.executedBy ??
    opts.deniedBy ??
    opts.heldBy ??
    "payment-system";

  const ctx = buildActionContext({
    actor: {
      id: actorId,
      type: "human",
    },
    resource: {
      id: opts.paymentId,
      type: "payment",
      ...(opts.vendorId !== undefined ? { vendor_id: opts.vendorId } : {}),
    },
    environment: "production",
    action_meta: {
      risk_level: riskLevel,
      reversibility: opts.action.includes("execute") ? "irreversible" : "reversible",
      description: `Payment operation '${opts.action}' on payment '${opts.paymentId}'`,
      ...(opts.amount !== undefined ? { estimated_amount: opts.amount } : {}),
      ...(opts.currency !== undefined ? { currency: opts.currency } : {}),
    },
    extra: {
      payment_action: opts.action,
      ...(opts.invoiceId !== undefined ? { invoice_id: opts.invoiceId } : {}),
      ...(opts.holdReason !== undefined ? { hold_reason: opts.holdReason } : {}),
      ...(opts.policyRule !== undefined ? { policy_rule: opts.policyRule } : {}),
      ...(opts.errorCode !== undefined ? { error_code: opts.errorCode } : {}),
      ...(opts.bankReference !== undefined ? { bank_reference: opts.bankReference } : {}),
      ...(opts.accountCode !== undefined ? { account_code: opts.accountCode } : {}),
      ...(opts.transactionId !== undefined ? { transaction_id: opts.transactionId } : {}),
    },
  });

  const request = {
    action: opts.action,
    agent: actorId,
    context: flattenActionContext(ctx),
  };

  if (ESCALATE_ACTIONS.has(opts.action) || riskLevel === "critical") {
    return protectOrEscalate(request, {
      escalationReason: `Payment operation '${opts.action}' on payment '${opts.paymentId}' requires approval`,
      assignedToRole: opts.assignedToRole ?? "finance-approver",
      quorumRequired: riskLevel === "critical" ? "simple_majority" : "single_approver",
      waitMs: opts.waitMs ?? 4 * 60 * 60 * 1000,
      ...(opts.onEscalationCreated !== undefined ? { onEscalationCreated: opts.onEscalationCreated } : {}),
      ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
      ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
    });
  }

  return protect(request);
}
