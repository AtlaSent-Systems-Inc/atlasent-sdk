import { protectOrEscalate } from "../approvalRuntime.js";
import { buildActionContext, flattenActionContext } from "../actionContext.js";
import type { ApprovalPermit } from "../approvalRuntime.js";
import type { EscalationHandle } from "../approvalRuntime.js";

export type BehaviorEventCategory =
  | "general"
  | "health.mental"
  | "health.adherence"
  | "financial"
  | "minor";

export const BEHAVIOR_SENSITIVE_CATEGORIES: BehaviorEventCategory[] = [
  "health.mental",
  "health.adherence",
  "financial",
  "minor",
];

export interface BehaviorEventOptions {
  action: "behavior.event.share";
  subjectId: string;
  eventCategory: BehaviorEventCategory;
  destination: string;
  purpose: string;
  consentVerified: boolean;
  dataMinimized: boolean;
  subjectIsMinor?: boolean;
  assignedToRole?: string;
  waitMs?: number;
  onEscalationCreated?: (handle: EscalationHandle) => void;
  apiKey?: string;
  baseUrl?: string;
}

function isSensitive(opts: BehaviorEventOptions): boolean {
  return (
    BEHAVIOR_SENSITIVE_CATEGORIES.includes(opts.eventCategory) ||
    (opts.subjectIsMinor === true)
  );
}

function classifyBehaviorRisk(opts: BehaviorEventOptions): "critical" | "high" | "medium" {
  if (opts.subjectIsMinor === true) return "critical";
  if (opts.eventCategory === "health.mental") return "critical";
  if (BEHAVIOR_SENSITIVE_CATEGORIES.includes(opts.eventCategory)) return "high";
  return "medium";
}

export async function protectBehaviorEvent(
  opts: BehaviorEventOptions,
): Promise<ApprovalPermit> {
  const riskLevel = classifyBehaviorRisk(opts);
  const sensitive = isSensitive(opts);

  const ctx = buildActionContext({
    actor: {
      id: opts.subjectId,
      type: "human",
    },
    resource: {
      id: opts.subjectId,
      type: "behavior_event",
      sensitivity: sensitive ? "restricted" : "confidential",
    },
    environment: "production",
    action_meta: {
      risk_level: riskLevel,
      reversibility: "irreversible",
      description: `Behavior event share for subject '${opts.subjectId}' category '${opts.eventCategory}' to '${opts.destination}'`,
    },
    extra: {
      behavior_event_category: opts.eventCategory,
      destination: opts.destination,
      purpose: opts.purpose,
      consent_verified: opts.consentVerified,
      data_minimized: opts.dataMinimized,
      machine_executable: !sensitive,
      subject_is_minor: opts.subjectIsMinor ?? false,
      hold_reason: opts.subjectIsMinor ? "HOLD_HUMAN_REVIEW_REQUIRED" : undefined,
    },
  });

  return protectOrEscalate(
    {
      action: opts.action,
      agent: opts.subjectId,
      context: flattenActionContext(ctx),
    },
    {
      escalationReason: opts.subjectIsMinor
        ? `HOLD_HUMAN_REVIEW_REQUIRED: behavior event share for minor subject '${opts.subjectId}'`
        : `Behavior event share for sensitive category '${opts.eventCategory}' requires human review`,
      assignedToRole: opts.assignedToRole ?? (opts.subjectIsMinor ? "safeguarding-officer" : "privacy-reviewer"),
      quorumRequired: opts.subjectIsMinor || riskLevel === "critical" ? "simple_majority" : "single_approver",
      waitMs: opts.waitMs ?? 4 * 60 * 60 * 1000,
      ...(opts.onEscalationCreated !== undefined ? { onEscalationCreated: opts.onEscalationCreated } : {}),
      ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
      ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
    },
  );
}
