import { protectOrEscalate } from "../approvalRuntime.js";
import { protect } from "../protect.js";
import { buildActionContext, flattenActionContext } from "../actionContext.js";
import type { ApprovalPermit } from "../approvalRuntime.js";
import type { Permit } from "../protect.js";
import type { EscalationHandle } from "../approvalRuntime.js";

export type InfraActionType =
  | "aws.ec2.stop_instance"
  | "aws.ec2.terminate_instance"
  | "github.repos.delete"
  | "database.table.drop"
  | "database.volume.delete"
  | "db.table.delete"
  | "infra.volume.delete";

const INFRA_ACTION_RISK: Record<InfraActionType, "critical" | "high"> = {
  "aws.ec2.stop_instance": "high",
  "aws.ec2.terminate_instance": "critical",
  "github.repos.delete": "critical",
  "database.table.drop": "critical",
  "database.volume.delete": "critical",
  "db.table.delete": "critical",
  "infra.volume.delete": "critical",
};

const MACHINE_EXECUTABLE_ACTIONS = new Set<InfraActionType>([
  "aws.ec2.stop_instance",
]);

const DATA_DESTRUCTIVE_ACTIONS = new Set<InfraActionType>([
  "database.table.drop",
  "database.volume.delete",
  "db.table.delete",
  "infra.volume.delete",
]);

export interface InfraActionOptions {
  action: InfraActionType;
  resourceId: string;
  authorizedBy: string;
  reason: string;
  changeTicket?: string;
  incidentId?: string;
  backupVerified?: boolean;
  region?: string;
  assignedToRole?: string;
  waitMs?: number;
  onEscalationCreated?: (handle: EscalationHandle) => void;
  apiKey?: string;
  baseUrl?: string;
}

export async function protectInfraAction(
  opts: InfraActionOptions,
): Promise<ApprovalPermit | Permit> {
  if (!opts.changeTicket && !opts.incidentId) {
    throw new TypeError(
      `Infrastructure action '${opts.action}' requires either 'changeTicket' or 'incidentId'`,
    );
  }

  if (DATA_DESTRUCTIVE_ACTIONS.has(opts.action) && opts.backupVerified !== true) {
    throw new TypeError(
      `Data-destructive action '${opts.action}' requires 'backupVerified: true'`,
    );
  }

  const riskLevel = INFRA_ACTION_RISK[opts.action] ?? "high";
  const machineExecutable = MACHINE_EXECUTABLE_ACTIONS.has(opts.action);
  const isDestructive = !machineExecutable;

  const ctx = buildActionContext({
    actor: {
      id: opts.authorizedBy,
      type: "human",
    },
    resource: {
      id: opts.resourceId,
      type: "infrastructure_resource",
    },
    environment: "production",
    action_meta: {
      risk_level: riskLevel,
      reversibility: DATA_DESTRUCTIVE_ACTIONS.has(opts.action) ? "irreversible" : opts.action === "aws.ec2.terminate_instance" ? "irreversible" : "reversible",
      description: `Infrastructure action '${opts.action}' on resource '${opts.resourceId}': ${opts.reason}`,
    },
    extra: {
      infra_action: opts.action,
      machine_executable: machineExecutable,
      reason: opts.reason,
      ...(opts.changeTicket !== undefined ? { change_ticket: opts.changeTicket } : {}),
      ...(opts.incidentId !== undefined ? { incident_id: opts.incidentId } : {}),
      ...(opts.backupVerified !== undefined ? { backup_verified: opts.backupVerified } : {}),
      ...(opts.region !== undefined ? { region: opts.region } : {}),
    },
  });

  const request = {
    action: opts.action,
    agent: opts.authorizedBy,
    context: flattenActionContext(ctx),
  };

  if (isDestructive || riskLevel === "critical") {
    return protectOrEscalate(request, {
      escalationReason: `Infrastructure action '${opts.action}' on '${opts.resourceId}' requires human approval (machine_executable: false)`,
      assignedToRole: opts.assignedToRole ?? (DATA_DESTRUCTIVE_ACTIONS.has(opts.action) ? "dba-approver" : "infra-approver"),
      quorumRequired: riskLevel === "critical" ? "simple_majority" : "single_approver",
      waitMs: opts.waitMs ?? 30 * 60 * 1000,
      ...(opts.onEscalationCreated !== undefined ? { onEscalationCreated: opts.onEscalationCreated } : {}),
      ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
      ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
    });
  }

  return protect(request);
}
