import { protectOrEscalate } from "../approvalRuntime.js";
import { protect } from "../protect.js";
import { buildActionContext, flattenActionContext } from "../actionContext.js";
import type { ApprovalPermit } from "../approvalRuntime.js";
import type { Permit } from "../protect.js";
import type { EscalationHandle } from "../approvalRuntime.js";

export interface PaymentReleaseOptions {
  amount: number;
  currency: string;
  vendorId: string;
  vendorName?: string;
  authorizedBy: string;
  reference?: string;
  description?: string;
  autoEscalateAbove?: number;
  requireDualApprovalAbove?: number;
  assignedToRole?: string;
  waitMs?: number;
  onEscalationCreated?: (handle: EscalationHandle) => void;
  apiKey?: string;
  baseUrl?: string;
}

const ISO_4217 = /^[A-Z]{3}$/;

export async function protectPaymentRelease(
  opts: PaymentReleaseOptions,
): Promise<ApprovalPermit | Permit> {
  if (!ISO_4217.test(opts.currency)) {
    throw new TypeError(
      `Invalid currency code '${opts.currency}': must be a 3-letter ISO 4217 code (e.g. USD, EUR, GBP)`,
    );
  }

  if (opts.amount <= 0) {
    throw new RangeError(`Payment amount must be greater than 0, got ${opts.amount}`);
  }

  const escalateThreshold = opts.autoEscalateAbove ?? 10_000;
  const dualThreshold = opts.requireDualApprovalAbove ?? 100_000;
  const needsEscalation = opts.amount > escalateThreshold;
  const needsDual = opts.amount > dualThreshold;

  const ctx = buildActionContext({
    actor: {
      id: opts.authorizedBy,
      type: "human",
    },
    resource: {
      id: opts.vendorId,
      name: opts.vendorName,
      type: "vendor",
    },
    environment: "production",
    action_meta: {
      risk_level: opts.amount > dualThreshold ? "critical" : opts.amount > escalateThreshold ? "high" : "medium",
      reversibility: "irreversible",
      estimated_amount: opts.amount,
      currency: opts.currency,
      description: opts.description ?? `Release ${opts.currency} ${opts.amount.toLocaleString()} to ${opts.vendorName ?? opts.vendorId}`,
    },
    extra: {
      reference: opts.reference,
    },
  });

  const request = {
    action: "payment.release",
    agent: opts.authorizedBy,
    context: flattenActionContext(ctx),
  };

  if (needsEscalation) {
    return protectOrEscalate(request, {
      escalationReason: `Payment of ${opts.currency} ${opts.amount.toLocaleString()} to ${opts.vendorName ?? opts.vendorId} exceeds auto-approval threshold of ${opts.currency} ${escalateThreshold.toLocaleString()}`,
      assignedToRole: opts.assignedToRole ?? "finance-approver",
      quorumRequired: needsDual ? "dual" : "single",
      waitMs: opts.waitMs ?? 4 * 60 * 60 * 1000,
      onEscalationCreated: opts.onEscalationCreated,
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
    });
  }
  return protect(request);
}
