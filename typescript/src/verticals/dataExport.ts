import { protectOrEscalate } from "../approvalRuntime.js";
import { protect } from "../protect.js";
import { buildActionContext, flattenActionContext } from "../actionContext.js";
import type { ApprovalPermit } from "../approvalRuntime.js";
import type { Permit } from "../protect.js";
import type { EscalationHandle } from "../approvalRuntime.js";

export const CUSTOMER_DATA_EXPORT_ACTION = "customer.data.export" as const;

export interface DataExportOptions {
  dataset: string;
  destination: string;
  containsPii: boolean;
  rowCount: number;
  dataClassification: "public" | "internal" | "confidential" | "restricted";
  purpose: string;
  dpaReference?: string;
  encryption?: string;
  authorizedBy: string;
  rowCap?: number;
  assignedToRole?: string;
  waitMs?: number;
  onEscalationCreated?: (handle: EscalationHandle) => void;
  apiKey?: string;
  baseUrl?: string;
}

function classifyExportRisk(opts: DataExportOptions): "low" | "medium" | "high" | "critical" {
  if (opts.containsPii && opts.rowCount > 10000) return "critical";
  if (opts.containsPii) return "high";
  if (opts.dataClassification === "confidential" || opts.dataClassification === "restricted") return "high";
  return "medium";
}

export async function protectDataExport(
  opts: DataExportOptions,
): Promise<ApprovalPermit | Permit> {
  const riskLevel = classifyExportRisk(opts);

  const ctx = buildActionContext({
    actor: {
      id: opts.authorizedBy,
      type: "human",
    },
    resource: {
      id: opts.dataset,
      type: "dataset",
      sensitivity: opts.dataClassification,
    },
    environment: "production",
    action_meta: {
      risk_level: riskLevel,
      reversibility: "irreversible",
      description: `Export dataset '${opts.dataset}' to '${opts.destination}' (${opts.rowCount} rows, PII: ${opts.containsPii})`,
    },
    extra: {
      destination: opts.destination,
      row_count: opts.rowCount,
      contains_pii: opts.containsPii,
      data_classification: opts.dataClassification,
      purpose: opts.purpose,
      dpa_reference: opts.dpaReference,
      encryption: opts.encryption,
      row_cap: opts.rowCap,
    },
  });

  const request = {
    action: CUSTOMER_DATA_EXPORT_ACTION,
    agent: opts.authorizedBy,
    context: flattenActionContext(ctx),
  };

  if (riskLevel === "critical" || riskLevel === "high") {
    return protectOrEscalate(request, {
      escalationReason: `Data export of '${opts.dataset}' to '${opts.destination}' requires approval (risk: ${riskLevel})`,
      assignedToRole: opts.assignedToRole ?? "data-governance",
      waitMs: opts.waitMs ?? 4 * 60 * 60 * 1000,
      ...(opts.onEscalationCreated !== undefined ? { onEscalationCreated: opts.onEscalationCreated } : {}),
      ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
      ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
    });
  }
  return protect(request);
}
