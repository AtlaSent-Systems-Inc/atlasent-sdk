import { protectOrEscalate } from "../approvalRuntime.js";
import { protect } from "../protect.js";
import { protectShadow } from "../shadow.js";
import { buildActionContext, flattenActionContext } from "../actionContext.js";
import type { ApprovalPermit } from "../approvalRuntime.js";
import type { Permit } from "../types.js";
import type { ShadowOutcome } from "../shadow.js";
import type { EscalationHandle } from "../approvalRuntime.js";

export type AgentToolMode = "observe" | "enforce" | "escalate";

export interface AgentToolOptions {
  toolName: string;
  toolArgs: Record<string, unknown>;
  agentId: string;
  sessionId?: string;
  riskLevel?: "critical" | "high" | "medium" | "low";
  mode?: AgentToolMode;
  assignedToRole?: string;
  waitMs?: number;
  description?: string;
  onEscalationCreated?: (handle: EscalationHandle) => void;
  apiKey?: string;
  baseUrl?: string;
}

const HIGH_RISK_TOOLS = new Set([
  "bash", "shell", "exec", "execute_code", "run_command",
  "write_file", "delete_file", "overwrite_file",
  "sql_execute", "db_write", "db_delete",
  "send_email", "send_message", "post_to_slack",
  "create_pr", "merge_pr", "push_code",
  "deploy", "release",
  "make_payment", "transfer_funds",
  "create_user", "delete_user", "modify_permissions",
  "aws_cli", "gcloud", "kubectl",
]);

const CRITICAL_TOOLS = new Set([
  "bash", "shell", "exec", "execute_code", "run_command",
  "delete_file", "db_delete",
  "make_payment", "transfer_funds",
  "delete_user", "modify_permissions",
  "deploy", "release",
]);

export function classifyToolRisk(
  toolName: string,
): "critical" | "high" | "medium" | "low" {
  const normalized = toolName.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  if (CRITICAL_TOOLS.has(normalized)) return "critical";
  if (HIGH_RISK_TOOLS.has(normalized)) return "high";
  if (normalized.includes("write") || normalized.includes("create") || normalized.includes("update")) return "medium";
  return "low";
}

export async function protectToolCall(
  opts: AgentToolOptions,
): Promise<ApprovalPermit | Permit | ShadowOutcome> {
  const inferredRisk = opts.riskLevel ?? classifyToolRisk(opts.toolName);
  const mode = opts.mode ?? (inferredRisk === "low" ? "enforce" : "escalate");

  const ctx = buildActionContext({
    actor: {
      id: opts.agentId,
      type: "agent",
      session_id: opts.sessionId,
    },
    resource: {
      type: "agent_tool",
      id: opts.toolName,
    },
    environment: "production",
    action_meta: {
      risk_level: inferredRisk,
      reversibility: inferredRisk === "critical" || inferredRisk === "high" ? "irreversible" : "reversible",
      description: opts.description ?? `Agent ${opts.agentId} calling tool '${opts.toolName}'`,
    },
    extra: {
      tool_args_keys: Object.keys(opts.toolArgs),
      session_id: opts.sessionId,
    },
  });

  const request = {
    action: `agent_tool.${opts.toolName}`,
    resourceId: opts.toolName,
    agentId: opts.agentId,
    context: flattenActionContext(ctx),
  };

  if (mode === "observe") {
    return protectShadow(request, { mode: "observe" });
  }

  if (mode === "escalate" || inferredRisk === "critical") {
    return protectOrEscalate(request, {
      escalationReason: `Agent '${opts.agentId}' is calling ${inferredRisk}-risk tool '${opts.toolName}'`,
      assignedToRole: opts.assignedToRole ?? "agent-supervisor",
      riskScore: inferredRisk === "critical" ? 1.0 : inferredRisk === "high" ? 0.75 : 0.5,
      waitMs: opts.waitMs ?? 15 * 60 * 1000,
      onEscalationCreated: opts.onEscalationCreated,
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
    });
  }

  return protect(request);
}
