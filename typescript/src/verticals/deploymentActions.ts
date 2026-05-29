import { protectOrEscalate } from "../approvalRuntime.js";
import { buildActionContext, flattenActionContext } from "../actionContext.js";
import type { ApprovalPermit } from "../approvalRuntime.js";
import type { EscalationHandle } from "../approvalRuntime.js";

export type DeploymentActionType =
  | "deployment.production.execute"
  | "deployment.staging.execute"
  | "deployment.rollback.execute";

/**
 * V1 backward-compatibility constant. The original `production.deploy`
 * action string from deployGate.ts is still supported by the server.
 * Use `DeploymentActionType` values for new V2 integrations.
 */
export const DEPLOY_V1_ACTION = "production.deploy" as const;

const DEPLOYMENT_ACTION_RISK: Record<DeploymentActionType, "critical" | "high"> = {
  "deployment.production.execute": "critical",
  "deployment.staging.execute": "high",
  "deployment.rollback.execute": "critical",
};

export interface DeploymentV2Options {
  action: DeploymentActionType;
  deploymentId: string;
  buildSha: string;
  environment: "production" | "staging";
  approvedBy?: string;
  rollbackPlan?: string;
  changeTicket?: string;
  incidentId?: string;
  rollbackTarget?: string;
  authorizedBy?: string;
  assignedToRole?: string;
  waitMs?: number;
  onEscalationCreated?: (handle: EscalationHandle) => void;
  apiKey?: string;
  baseUrl?: string;
}

export async function protectDeploymentV2(
  opts: DeploymentV2Options,
): Promise<ApprovalPermit> {
  if (opts.action === "deployment.rollback.execute") {
    if (!opts.incidentId) {
      throw new TypeError(
        `deployment.rollback.execute requires 'incidentId' to be set`,
      );
    }
    if (!opts.rollbackTarget) {
      throw new TypeError(
        `deployment.rollback.execute requires 'rollbackTarget' to be set`,
      );
    }
  }

  const riskLevel = DEPLOYMENT_ACTION_RISK[opts.action] ?? "high";
  const actorId = opts.authorizedBy ?? opts.approvedBy ?? "deploy-system";

  const ctx = buildActionContext({
    actor: {
      id: actorId,
      type: "service_account",
    },
    resource: {
      id: opts.deploymentId,
      type: "deployment",
    },
    environment: opts.environment,
    action_meta: {
      risk_level: riskLevel,
      reversibility: opts.action === "deployment.rollback.execute" ? "partial" : "irreversible",
      description: `Deployment V2 '${opts.action}' for '${opts.deploymentId}' at sha '${opts.buildSha.slice(0, 8)}'`,
    },
    extra: {
      build_sha: opts.buildSha,
      ...(opts.changeTicket !== undefined ? { change_ticket: opts.changeTicket } : {}),
      ...(opts.rollbackPlan !== undefined ? { rollback_plan: opts.rollbackPlan } : {}),
      ...(opts.incidentId !== undefined ? { incident_id: opts.incidentId } : {}),
      ...(opts.rollbackTarget !== undefined ? { rollback_target: opts.rollbackTarget } : {}),
    },
  });

  return protectOrEscalate(
    {
      action: opts.action,
      agent: actorId,
      context: flattenActionContext(ctx),
    },
    {
      escalationReason: `Deployment V2 '${opts.action}' of '${opts.deploymentId}' requires human approval`,
      assignedToRole: opts.assignedToRole ?? "release-manager",
      quorumRequired: riskLevel === "critical" ? "simple_majority" : "single_approver",
      waitMs: opts.waitMs ?? 30 * 60 * 1000,
      ...(opts.onEscalationCreated !== undefined ? { onEscalationCreated: opts.onEscalationCreated } : {}),
      ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
      ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
    },
  );
}
