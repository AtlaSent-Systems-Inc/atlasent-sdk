import { protectOrEscalate } from "../approvalRuntime.js";
import { protect } from "../protect.js";
import { buildActionContext, flattenActionContext } from "../actionContext.js";
import type { ApprovalPermit } from "../approvalRuntime.js";
import type { Permit } from "../protect.js";
import type { EscalationHandle } from "../approvalRuntime.js";

export type PricingActionType =
  | "pricing.rule.publish"
  | "pricing.discount.approve";

function classifyPricingRisk(opts: PricingActionOptions): "high" | "medium" {
  if (opts.action === "pricing.rule.publish") {
    return "high";
  }
  // pricing.discount.approve: medium for <10%, high for >=10%
  const pct = opts.discountPercent ?? 0;
  return pct >= 10 ? "high" : "medium";
}

function isPricingMachineExecutable(opts: PricingActionOptions): boolean {
  if (opts.action === "pricing.rule.publish") {
    // machine_executable: true for changes <5%, false for >=5%
    const pct = opts.priceChangePct ?? 0;
    return pct < 5;
  }
  // pricing.discount.approve: machine_executable: true for small (<10%) discounts
  const pct = opts.discountPercent ?? 0;
  return pct < 10;
}

export interface PricingActionOptions {
  action: PricingActionType;
  ruleId: string;
  authorizedBy: string;
  // pricing.rule.publish
  priceChangePct?: number;
  affectedSkus?: string[];
  effectiveDate?: string;
  // pricing.discount.approve
  discountPercent?: number;
  customerId?: string;
  discountReason?: string;
  assignedToRole?: string;
  waitMs?: number;
  onEscalationCreated?: (handle: EscalationHandle) => void;
  apiKey?: string;
  baseUrl?: string;
}

export async function protectPricingAction(
  opts: PricingActionOptions,
): Promise<ApprovalPermit | Permit> {
  const riskLevel = classifyPricingRisk(opts);
  const machineExecutable = isPricingMachineExecutable(opts);

  const ctx = buildActionContext({
    actor: {
      id: opts.authorizedBy,
      type: "human",
    },
    resource: {
      id: opts.ruleId,
      type: "pricing_rule",
    },
    environment: "production",
    action_meta: {
      risk_level: riskLevel,
      reversibility: "reversible",
      description: `Pricing action '${opts.action}' on rule '${opts.ruleId}'`,
    },
    extra: {
      pricing_action: opts.action,
      machine_executable: machineExecutable,
      ...(opts.priceChangePct !== undefined ? { price_change_pct: opts.priceChangePct } : {}),
      ...(opts.affectedSkus !== undefined ? { affected_skus: opts.affectedSkus } : {}),
      ...(opts.effectiveDate !== undefined ? { effective_date: opts.effectiveDate } : {}),
      ...(opts.discountPercent !== undefined ? { discount_percent: opts.discountPercent } : {}),
      ...(opts.customerId !== undefined ? { customer_id: opts.customerId } : {}),
      ...(opts.discountReason !== undefined ? { discount_reason: opts.discountReason } : {}),
    },
  });

  const request = {
    action: opts.action,
    agent: opts.authorizedBy,
    context: flattenActionContext(ctx),
  };

  if (!machineExecutable || riskLevel === "high") {
    return protectOrEscalate(request, {
      escalationReason: `Pricing action '${opts.action}' on '${opts.ruleId}' requires human approval (machine_executable: false)`,
      assignedToRole: opts.assignedToRole ?? "pricing-approver",
      quorumRequired: "single_approver",
      waitMs: opts.waitMs ?? 4 * 60 * 60 * 1000,
      ...(opts.onEscalationCreated !== undefined ? { onEscalationCreated: opts.onEscalationCreated } : {}),
      ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
      ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
    });
  }

  return protect(request);
}

export async function protectPricingRule(
  opts: Omit<PricingActionOptions, "action">,
): Promise<ApprovalPermit | Permit> {
  return protectPricingAction({ ...opts, action: "pricing.rule.publish" });
}
