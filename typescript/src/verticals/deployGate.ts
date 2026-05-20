import { protectOrEscalate } from "../approvalRuntime.js";
import { protect } from "../protect.js";
import { buildActionContext, flattenActionContext } from "../actionContext.js";
import type { ApprovalPermit } from "../approvalRuntime.js";
import type { Permit } from "../protect.js";
import type { EscalationHandle } from "../approvalRuntime.js";

export type DeployEnvironment = "production" | "staging" | "development" | string;

export interface DeployGateOptions {
  service: string;
  resourceType?: string;
  sha?: string;
  workflow?: string;
  actorId?: string;
  actorLabel?: string;
  environment?: DeployEnvironment;
  description?: string;
  requireApproval?: boolean;
  assignedToRole?: string;
  waitMs?: number;
  onEscalationCreated?: (handle: EscalationHandle) => void;
  apiKey?: string;
  baseUrl?: string;
}

function resolveEnvActor(): string | undefined {
  return (
    process.env["GITHUB_ACTOR"] ??
    process.env["GITLAB_USER_LOGIN"] ??
    process.env["CIRCLE_USERNAME"] ??
    process.env["BITBUCKET_STEP_TRIGGERER_UUID"] ??
    undefined
  );
}

function resolveEnvSha(): string | undefined {
  return (
    process.env["GITHUB_SHA"] ??
    process.env["CI_COMMIT_SHA"] ??
    process.env["CIRCLE_SHA1"] ??
    process.env["BITBUCKET_COMMIT"] ??
    undefined
  );
}

function resolveEnvWorkflow(): string | undefined {
  return (
    process.env["GITHUB_WORKFLOW"] ??
    process.env["CI_PIPELINE_NAME"] ??
    process.env["CIRCLE_WORKFLOW_NAME"] ??
    undefined
  );
}

export async function protectDeploy(
  opts: DeployGateOptions,
): Promise<ApprovalPermit | Permit> {
  const actorId = opts.actorId ?? resolveEnvActor() ?? "ci-system";
  const sha = opts.sha ?? resolveEnvSha();
  const workflow = opts.workflow ?? resolveEnvWorkflow();
  const environment = opts.environment ?? "production";
  const isProduction = environment === "production";

  const ctx = buildActionContext({
    actor: {
      id: actorId,
      type: "service_account",
      ...(opts.actorLabel !== undefined ? { label: opts.actorLabel } : {}),
    },
    resource: {
      id: opts.service,
      type: opts.resourceType ?? "service",
    },
    environment,
    action_meta: {
      risk_level: isProduction ? "critical" : "medium",
      reversibility: "partial",
      ...(opts.description !== undefined
        ? { description: opts.description }
        : sha !== undefined
          ? { description: `Deploy ${sha.slice(0, 8)} to ${environment}` }
          : {}),
    },
    extra: {
      sha,
      workflow,
    },
  });

  const request = {
    action: "production.deploy",
    agent: actorId,
    context: flattenActionContext(ctx),
  };

  if (opts.requireApproval || isProduction) {
    return protectOrEscalate(request, {
      escalationReason: `Production deployment of ${opts.service} requires human approval`,
      assignedToRole: opts.assignedToRole ?? "release-manager",
      waitMs: opts.waitMs ?? 30 * 60 * 1000,
      ...(opts.onEscalationCreated !== undefined ? { onEscalationCreated: opts.onEscalationCreated } : {}),
      ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
      ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
    });
  }
  return protect(request);
}
