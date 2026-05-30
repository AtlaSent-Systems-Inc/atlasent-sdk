import { protectOrEscalate } from "../approvalRuntime.js";
import { buildActionContext, flattenActionContext } from "../actionContext.js";
import type { ApprovalPermit } from "../approvalRuntime.js";
import type { EscalationHandle } from "../approvalRuntime.js";

export type SecurityActionType =
  | "security.incident.escalate"
  | "security.access.quarantine";

const SECURITY_ACTION_RISK: Record<SecurityActionType, "critical"> = {
  "security.incident.escalate": "critical",
  "security.access.quarantine": "critical",
};

// All security actions are non-machine-executable and fail-closed.
const MACHINE_EXECUTABLE_ACTIONS = new Set<SecurityActionType>();

export interface SecurityActionOptions {
  action: SecurityActionType;
  authorizedBy: string;
  // security.incident.escalate — required
  incidentId?: string;
  severity?: "low" | "medium" | "high" | "critical";
  // security.access.quarantine — required
  targetId?: string;
  quarantineReason?: string;
  onEscalationCreated?: (handle: EscalationHandle) => void;
  apiKey?: string;
  baseUrl?: string;
}

export async function protectSecurityAction(
  opts: SecurityActionOptions,
): Promise<ApprovalPermit> {
  if (opts.action === "security.incident.escalate") {
    if (!opts.incidentId) {
      throw new TypeError(
        `Security action 'security.incident.escalate' requires 'incidentId'`,
      );
    }
    if (!opts.severity) {
      throw new TypeError(
        `Security action 'security.incident.escalate' requires 'severity'`,
      );
    }
  }

  if (opts.action === "security.access.quarantine") {
    if (!opts.targetId) {
      throw new TypeError(
        `Security action 'security.access.quarantine' requires 'targetId'`,
      );
    }
    if (!opts.quarantineReason) {
      throw new TypeError(
        `Security action 'security.access.quarantine' requires 'quarantineReason'`,
      );
    }
  }

  const riskLevel = SECURITY_ACTION_RISK[opts.action];

  const resourceId =
    opts.action === "security.incident.escalate"
      ? opts.incidentId!
      : opts.targetId!;

  const ctx = buildActionContext({
    actor: {
      id: opts.authorizedBy,
      type: "human",
    },
    resource: {
      id: resourceId,
      type:
        opts.action === "security.incident.escalate"
          ? "security_incident"
          : "access_principal",
      sensitivity: "restricted",
    },
    environment: "production",
    action_meta: {
      risk_level: riskLevel,
      reversibility: "irreversible",
      description: `Security action '${opts.action}' on resource '${resourceId}'`,
    },
    extra: {
      security_action: opts.action,
      machine_executable: false,
      fail_closed: true,
      ...(opts.incidentId !== undefined ? { incident_id: opts.incidentId } : {}),
      ...(opts.severity !== undefined ? { severity: opts.severity } : {}),
      ...(opts.targetId !== undefined ? { target_id: opts.targetId } : {}),
      ...(opts.quarantineReason !== undefined
        ? { quarantine_reason: opts.quarantineReason }
        : {}),
    },
  });

  const request = {
    action: opts.action,
    agent: opts.authorizedBy,
    context: flattenActionContext(ctx),
  };

  return protectOrEscalate(request, {
    escalationReason: `Security action '${opts.action}' on '${resourceId}' requires human review (machine_executable: false, fail_closed: true)`,
    assignedToRole: "security-approver",
    quorumRequired: "simple_majority",
    waitMs: 3_600_000,
    ...(opts.onEscalationCreated !== undefined
      ? { onEscalationCreated: opts.onEscalationCreated }
      : {}),
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
  });
}

export async function protectSecurityIncidentEscalate(
  opts: Omit<SecurityActionOptions, "action"> & {
    incidentId: string;
    severity: "low" | "medium" | "high" | "critical";
  },
): Promise<ApprovalPermit> {
  return protectSecurityAction({
    ...opts,
    action: "security.incident.escalate",
  });
}

export async function protectSecurityAccessQuarantine(
  opts: Omit<SecurityActionOptions, "action"> & {
    targetId: string;
    quarantineReason: string;
  },
): Promise<ApprovalPermit> {
  return protectSecurityAction({
    ...opts,
    action: "security.access.quarantine",
  });
}
