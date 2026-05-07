export type AccessStatus = "active" | "grace" | "restricted" | "suspended";
export type BillingMode  = "self_serve" | "invoice" | "manual_contract";
export type InvoiceStatus =
  | "none" | "draft" | "open" | "paid"
  | "overdue" | "void" | "uncollectible";
export type DenyReason =
  | "billing_suspended"
  | "billing_restricted"
  | "billing_grace_period"
  | "billing_contract_expired"
  | "billing_manual_override"
  | "billing_unknown_state";
export type AllowedAction =
  | "govern"
  | "evaluate"
  | "audit"
  | "audit_export_legal"
  | "billing_manage"
  | "seat_add"
  | "plan_upgrade"
  | "noncritical_export"
  | "api_access"
  | "governance_read";

export interface BillingEntitlement {
  org_id:                 string;
  access_status:          AccessStatus;
  effective_status:       AccessStatus;
  allowed_actions:        AllowedAction[];
  deny_reason:            DenyReason | null;
  warning:                string | null;
  grace_until:            string | null;
  billing_mode:           string;
  plan:                   string;
  invoice_status:         string;
  manual_override:        boolean;
  manual_override_status: string | null;
  manual_override_reason: string | null;
  computed_at:            string;
}

export interface AdminOverrideRequest {
  org_id:      string;
  status?:     AccessStatus;
  reason:      string;
  expires_at?: string;
}

export interface AdminOverrideResponse {
  org_id:               string;
  new_status?:          string;
  override_active:      boolean;
  override_status?:     string;
  override_reason?:     string;
  override_expires_at?: string;
}

export function hasAction(
  entitlement: BillingEntitlement,
  action: AllowedAction | string,
): boolean {
  return (entitlement.allowed_actions as string[]).includes(action);
}

export function isActive(entitlement: BillingEntitlement): boolean {
  return entitlement.access_status === "active";
}

export function isBlocked(entitlement: BillingEntitlement): boolean {
  return entitlement.access_status === "suspended";
}

export interface BillingCompatibleClient {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  baseUrl: string;
}

export class BillingClient {
  readonly #client: BillingCompatibleClient;

  constructor(client: BillingCompatibleClient) {
    this.#client = client;
  }

  async getEntitlement(orgId?: string): Promise<BillingEntitlement> {
    const url = new URL(`${this.#client.baseUrl}/v1/billing/entitlement`);
    if (orgId) url.searchParams.set("org_id", orgId);
    const res = await this.#client.fetch(url.toString(), { method: "GET" });
    if (!res.ok) throw new Error(`billing entitlement fetch failed: ${res.status}`);
    return res.json() as Promise<BillingEntitlement>;
  }

  async setOverride(request: AdminOverrideRequest): Promise<AdminOverrideResponse> {
    const res = await this.#client.fetch(
      `${this.#client.baseUrl}/v1/billing/admin-override`,
      {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(request),
      },
    );
    if (!res.ok) throw new Error(`billing override failed: ${res.status}`);
    return res.json() as Promise<AdminOverrideResponse>;
  }

  async clearOverride(
    orgId: string,
    reason = "Cleared via SDK",
  ): Promise<AdminOverrideResponse> {
    return this.setOverride({ org_id: orgId, reason });
  }
}
