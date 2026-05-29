import { protectOrEscalate } from "../approvalRuntime.js";
import { buildActionContext, flattenActionContext } from "../actionContext.js";
import type { ApprovalPermit } from "../approvalRuntime.js";
import type { EscalationHandle } from "../approvalRuntime.js";

export type AccessCertActionType = "access.cert.revoke";

const ACCESS_CERT_ACTION_RISK: Record<AccessCertActionType, "high"> = {
  "access.cert.revoke": "high",
};

// access.cert.revoke is non-machine-executable.
const MACHINE_EXECUTABLE_ACTIONS = new Set<AccessCertActionType>();

export interface AccessCertOptions {
  action: AccessCertActionType;
  certId: string;
  revocationReason: string;
  authorizedBy?: string;
  onEscalationCreated?: (handle: EscalationHandle) => void;
  apiKey?: string;
  baseUrl?: string;
}

export async function protectAccessCertAction(
  opts: AccessCertOptions,
): Promise<ApprovalPermit> {
  if (!opts.certId) {
    throw new TypeError(
      `Access cert action 'access.cert.revoke' requires 'certId'`,
    );
  }
  if (!opts.revocationReason) {
    throw new TypeError(
      `Access cert action 'access.cert.revoke' requires 'revocationReason'`,
    );
  }

  const riskLevel = ACCESS_CERT_ACTION_RISK[opts.action];
  const actor = opts.authorizedBy ?? "system";

  const ctx = buildActionContext({
    actor: {
      id: actor,
      type: "human",
    },
    resource: {
      id: opts.certId,
      type: "access_certificate",
      sensitivity: "restricted",
    },
    environment: "production",
    action_meta: {
      risk_level: riskLevel,
      reversibility: "irreversible",
      description: `Access cert action '${opts.action}' on cert '${opts.certId}'`,
    },
    extra: {
      access_cert_action: opts.action,
      machine_executable: false,
      cert_id: opts.certId,
      revocation_reason: opts.revocationReason,
    },
  });

  const request = {
    action: opts.action,
    agent: actor,
    context: flattenActionContext(ctx),
  };

  return protectOrEscalate(request, {
    escalationReason: `Access cert action '${opts.action}' on cert '${opts.certId}' requires human review (machine_executable: false)`,
    assignedToRole: "security-approver",
    quorumRequired: "single_approver",
    waitMs: 86_400_000,
    ...(opts.onEscalationCreated !== undefined
      ? { onEscalationCreated: opts.onEscalationCreated }
      : {}),
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
  });
}

export async function protectAccessCertRevoke(
  opts: Omit<AccessCertOptions, "action">,
): Promise<ApprovalPermit> {
  return protectAccessCertAction({ ...opts, action: "access.cert.revoke" });
}
