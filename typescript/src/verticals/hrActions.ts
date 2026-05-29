import { protectOrEscalate } from "../approvalRuntime.js";
import { protect } from "../protect.js";
import { buildActionContext, flattenActionContext } from "../actionContext.js";
import type { ApprovalPermit } from "../approvalRuntime.js";
import type { Permit } from "../protect.js";
import type { EscalationHandle } from "../approvalRuntime.js";

export type HrActionType =
  | "hr.employee.offboard"
  | "hr.access.revoke"
  | "hr.role.escalate";

const HR_ACTION_RISK: Record<HrActionType, "critical" | "high"> = {
  "hr.employee.offboard": "high",
  "hr.access.revoke": "high",
  "hr.role.escalate": "critical",
};

const MACHINE_EXECUTABLE_ACTIONS = new Set<HrActionType>([
  "hr.access.revoke",
]);

export interface HrActionOptions {
  action: HrActionType;
  employeeId: string;
  authorizedBy: string;
  // offboard-specific
  effectiveDate?: string;
  offboardingReason?: string;
  // role-escalate-specific
  requestedRole?: string;
  businessJustification?: string;
  assignedToRole?: string;
  waitMs?: number;
  onEscalationCreated?: (handle: EscalationHandle) => void;
  apiKey?: string;
  baseUrl?: string;
}

export async function protectHrAction(
  opts: HrActionOptions,
): Promise<ApprovalPermit | Permit> {
  if (opts.action === "hr.employee.offboard") {
    if (!opts.effectiveDate) {
      throw new TypeError(
        `HR action 'hr.employee.offboard' requires 'effectiveDate'`,
      );
    }
    if (!opts.offboardingReason) {
      throw new TypeError(
        `HR action 'hr.employee.offboard' requires 'offboardingReason'`,
      );
    }
  }

  if (opts.action === "hr.role.escalate") {
    if (!opts.requestedRole) {
      throw new TypeError(
        `HR action 'hr.role.escalate' requires 'requestedRole'`,
      );
    }
    if (!opts.businessJustification) {
      throw new TypeError(
        `HR action 'hr.role.escalate' requires 'businessJustification'`,
      );
    }
  }

  const riskLevel = HR_ACTION_RISK[opts.action] ?? "high";
  const machineExecutable = MACHINE_EXECUTABLE_ACTIONS.has(opts.action);

  const ctx = buildActionContext({
    actor: {
      id: opts.authorizedBy,
      type: "human",
    },
    resource: {
      id: opts.employeeId,
      type: "hr_employee_record",
      sensitivity: "restricted",
    },
    environment: "production",
    action_meta: {
      risk_level: riskLevel,
      reversibility: opts.action === "hr.employee.offboard" ? "irreversible" : "reversible",
      description: `HR action '${opts.action}' on employee '${opts.employeeId}'`,
    },
    extra: {
      hr_action: opts.action,
      machine_executable: machineExecutable,
      ...(opts.effectiveDate !== undefined ? { effective_date: opts.effectiveDate } : {}),
      ...(opts.offboardingReason !== undefined ? { offboarding_reason: opts.offboardingReason } : {}),
      ...(opts.requestedRole !== undefined ? { requested_role: opts.requestedRole } : {}),
      ...(opts.businessJustification !== undefined ? { business_justification: opts.businessJustification } : {}),
    },
  });

  const request = {
    action: opts.action,
    agent: opts.authorizedBy,
    context: flattenActionContext(ctx),
  };

  if (!machineExecutable || riskLevel === "critical") {
    return protectOrEscalate(request, {
      escalationReason: `HR action '${opts.action}' on employee '${opts.employeeId}' requires human review (machine_executable: false)`,
      assignedToRole: opts.assignedToRole ?? (riskLevel === "critical" ? "security-approver" : "hr-approver"),
      quorumRequired: riskLevel === "critical" ? "simple_majority" : "single_approver",
      waitMs: opts.waitMs ?? 24 * 60 * 60 * 1000,
      ...(opts.onEscalationCreated !== undefined ? { onEscalationCreated: opts.onEscalationCreated } : {}),
      ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
      ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
    });
  }

  return protect(request);
}

export async function protectHrOffboard(
  opts: Omit<HrActionOptions, "action"> & { effectiveDate: string; offboardingReason: string },
): Promise<ApprovalPermit | Permit> {
  return protectHrAction({ ...opts, action: "hr.employee.offboard" });
}

export async function protectHrRoleEscalate(
  opts: Omit<HrActionOptions, "action"> & { requestedRole: string; businessJustification: string },
): Promise<ApprovalPermit | Permit> {
  return protectHrAction({ ...opts, action: "hr.role.escalate" });
}
