/**
 * SSO administration — connections, JIT rules, events, enforcement state
 * machine, and the `client.sso` sub-client.
 *
 * Usage:
 *
 * ```ts
 * import { AtlaSentClient } from "@atlasent/sdk";
 *
 * const client = new AtlaSentClient({ apiKey: "..." });
 *
 * const { connections } = await client.sso.listConnections();
 * const status = await client.sso.getStatus();
 * await client.sso.enforce("enable");
 * ```
 */

// ── Connections ───────────────────────────────────────────────────────────────

/** An SSO connection record (SAML 2.0 or OIDC). */
export interface SsoConnection {
  id: string;
  organizationId: string;
  name: string;
  protocol: "saml" | "oidc";
  idpEntityId: string;
  metadataUrl: string | null;
  metadataXml: string | null;
  emailDomain: string | null;
  enforceForDomain: boolean;
  isActive: boolean;
  supabaseProviderId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Wire (snake_case) shape for SSO connection responses. */
export interface SsoConnectionWire {
  id: string;
  organization_id: string;
  name: string;
  protocol: "saml" | "oidc";
  idp_entity_id: string;
  metadata_url: string | null;
  metadata_xml: string | null;
  email_domain: string | null;
  enforce_for_domain: boolean;
  is_active: boolean;
  supabase_provider_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export function wireToSsoConnection(w: SsoConnectionWire): SsoConnection {
  return {
    id: w.id,
    organizationId: w.organization_id,
    name: w.name,
    protocol: w.protocol,
    idpEntityId: w.idp_entity_id,
    metadataUrl: w.metadata_url,
    metadataXml: w.metadata_xml,
    emailDomain: w.email_domain,
    enforceForDomain: w.enforce_for_domain,
    isActive: w.is_active,
    supabaseProviderId: w.supabase_provider_id,
    createdBy: w.created_by,
    createdAt: w.created_at,
    updatedAt: w.updated_at,
  };
}

// ── JIT provisioning rules ───────────────────────────────────────────────────

export type SsoRole = "owner" | "admin" | "approver" | "member" | "viewer";

/** A JIT provisioning rule that maps an IdP claim to an org role. */
export interface SsoJitRule {
  id: string;
  connectionId: string;
  organizationId: string;
  claimAttribute: string;
  claimValue: string;
  grantedRole: SsoRole;
  precedence: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Wire (snake_case) shape for JIT rule responses. */
export interface SsoJitRuleWire {
  id: string;
  connection_id: string;
  organization_id: string;
  claim_attribute: string;
  claim_value: string;
  granted_role: SsoRole;
  precedence: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export function wireToSsoJitRule(w: SsoJitRuleWire): SsoJitRule {
  return {
    id: w.id,
    connectionId: w.connection_id,
    organizationId: w.organization_id,
    claimAttribute: w.claim_attribute,
    claimValue: w.claim_value,
    grantedRole: w.granted_role,
    precedence: w.precedence,
    isActive: w.is_active,
    createdAt: w.created_at,
    updatedAt: w.updated_at,
  };
}

// ── Events ───────────────────────────────────────────────────────────────────

/**
 * An SSO lifecycle event — login, session, config change, break-glass, or
 * JIT provisioning.
 */
export interface SsoEvent {
  id: string;
  organizationId: string;
  connectionId: string | null;
  eventType: string;
  actorEmail: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
}

/** Wire (snake_case) shape for SSO event responses. */
export interface SsoEventWire {
  id: string;
  organization_id: string;
  connection_id: string | null;
  event_type: string;
  actor_email: string | null;
  payload: Record<string, unknown>;
  occurred_at: string;
}

export function wireToSsoEvent(w: SsoEventWire): SsoEvent {
  return {
    id: w.id,
    organizationId: w.organization_id,
    connectionId: w.connection_id,
    eventType: w.event_type,
    actorEmail: w.actor_email,
    payload: w.payload,
    occurredAt: w.occurred_at,
  };
}

// ── Enforcement state machine ─────────────────────────────────────────────────

/** Action to pass to `POST /v1/sso/enforce`. */
export type SsoEnforceAction = "enable" | "enforce";

/**
 * Four-boolean readiness checklist returned by `GET /v1/sso/status`.
 * All four must be `true` before enforcement is safe to activate.
 */
export interface SsoReadiness {
  /** At least one SSO connection row exists for the org. */
  connectionConfigured: boolean;
  /** At least one connection has been activated (registered with the IdP). */
  connectionTested: boolean;
  /** Break-glass access has been configured (non-default settings). */
  breakGlassSet: boolean;
  /** No unreviewed active service API keys exist. */
  serviceApiKeysReviewed: boolean;
}

/** Wire (snake_case) shape for the readiness response. */
export interface SsoReadinessWire {
  connection_configured: boolean;
  connection_tested: boolean;
  break_glass_set: boolean;
  service_api_keys_reviewed: boolean;
}

export function wireToSsoReadiness(w: SsoReadinessWire): SsoReadiness {
  return {
    connectionConfigured: w.connection_configured,
    connectionTested: w.connection_tested,
    breakGlassSet: w.break_glass_set,
    serviceApiKeysReviewed: w.service_api_keys_reviewed,
  };
}

// ── Sub-client ────────────────────────────────────────────────────────────────

/** Input for creating a JIT provisioning rule. */
export interface SsoJitRuleInput {
  connectionId: string;
  claimAttribute: string;
  claimValue: string;
  grantedRole: SsoRole;
  precedence?: number;
}

/** Patchable fields for an existing JIT rule. */
export interface SsoJitRulePatch {
  claimAttribute?: string;
  claimValue?: string;
  grantedRole?: SsoRole;
  precedence?: number;
  isActive?: boolean;
}

/** Input for creating or updating an SSO connection. */
export interface SsoConnectionInput {
  name: string;
  protocol: "saml" | "oidc";
  idpEntityId: string;
  metadataUrl?: string | null;
  metadataXml?: string | null;
  emailDomain?: string | null;
  enforceForDomain?: boolean;
}

/** Result of `POST /v1/sso/enforce`. */
export interface SsoEnforceResult {
  ok: boolean;
  action: SsoEnforceAction;
  enforceSso: boolean;
  enforceSsoAt: string | null;
}

interface SsoEnforceResultWire {
  ok: boolean;
  action: SsoEnforceAction;
  enforce_sso: boolean;
  enforce_sso_at: string | null;
}

/**
 * Sub-client for SSO administration.
 * Accessed as `client.sso` on {@link AtlaSentClient}.
 */
export interface SsoSubClient {
  /** List all SSO connections for the org. */
  listConnections(): Promise<{ connections: SsoConnection[] }>;

  /** Get a single SSO connection by ID. */
  getConnection(id: string): Promise<SsoConnection>;

  /** Create a new SSO connection. */
  createConnection(input: SsoConnectionInput): Promise<SsoConnection>;

  /** Update an existing SSO connection. */
  updateConnection(id: string, input: Partial<SsoConnectionInput>): Promise<SsoConnection>;

  /** Delete an SSO connection. */
  deleteConnection(id: string): Promise<void>;

  /** Activate (register) a connection with the IdP. */
  activateConnection(id: string): Promise<{ ok: boolean; supabaseProviderId: string | null }>;

  /**
   * Advance the SSO enforcement state machine.
   * `"enable"` → SSO enabled, not yet enforced.
   * `"enforce"` → SSO mandatory for all members (requires readiness checklist to pass).
   */
  enforce(action: SsoEnforceAction): Promise<SsoEnforceResult>;

  /** Get the four-boolean enforcement readiness checklist. */
  getStatus(): Promise<SsoReadiness>;

  // ── JIT provisioning rules ───────────────────────────────────────────────

  /** List JIT provisioning rules, optionally filtered to a single connection. */
  listJitRules(connectionId?: string): Promise<{ rules: SsoJitRule[] }>;

  /** Create a new JIT provisioning rule. */
  createJitRule(input: SsoJitRuleInput): Promise<SsoJitRule>;

  /** Update fields on an existing JIT rule. */
  patchJitRule(id: string, patch: SsoJitRulePatch): Promise<SsoJitRule>;

  /** Delete a JIT provisioning rule. */
  deleteJitRule(id: string): Promise<void>;
}

function ssoConnectionInputToWire(input: SsoConnectionInput | Partial<SsoConnectionInput>): Record<string, unknown> {
  const w: Record<string, unknown> = {};
  if (input.name !== undefined) w["name"] = input.name;
  if (input.protocol !== undefined) w["protocol"] = input.protocol;
  if (input.idpEntityId !== undefined) w["idp_entity_id"] = input.idpEntityId;
  if (input.metadataUrl !== undefined) w["metadata_url"] = input.metadataUrl;
  if (input.metadataXml !== undefined) w["metadata_xml"] = input.metadataXml;
  if (input.emailDomain !== undefined) w["email_domain"] = input.emailDomain;
  if (input.enforceForDomain !== undefined) w["enforce_for_domain"] = input.enforceForDomain;
  return w;
}

/**
 * Factory that returns the SSO sub-client bound to a host client's transport
 * helpers. Called internally by AtlaSentClient; not part of the public API.
 */
export function makeSsoClient(
  getFn: <T>(path: string, query?: URLSearchParams) => Promise<{ body: T }>,
  postFn: <T>(path: string, body: unknown) => Promise<{ body: T }>,
  patchFn: <T>(path: string, body: unknown) => Promise<{ body: T }>,
  deleteFn: (path: string) => Promise<void>,
): SsoSubClient {
  return {
    async listConnections() {
      const { body } = await getFn<{ connections: SsoConnectionWire[] }>("/v1/sso/connections");
      return { connections: (body.connections ?? []).map(wireToSsoConnection) };
    },

    async getConnection(id: string) {
      const { body } = await getFn<SsoConnectionWire>(`/v1/sso/connections/${encodeURIComponent(id)}`);
      return wireToSsoConnection(body);
    },

    async createConnection(input: SsoConnectionInput) {
      const { body } = await postFn<SsoConnectionWire>("/v1/sso/connections", ssoConnectionInputToWire(input));
      return wireToSsoConnection(body);
    },

    async updateConnection(id: string, input: Partial<SsoConnectionInput>) {
      const { body } = await patchFn<SsoConnectionWire>(
        `/v1/sso/connections/${encodeURIComponent(id)}`,
        ssoConnectionInputToWire(input),
      );
      return wireToSsoConnection(body);
    },

    async deleteConnection(id: string) {
      await deleteFn(`/v1/sso/connections/${encodeURIComponent(id)}`);
    },

    async activateConnection(id: string) {
      const { body } = await postFn<{ ok: boolean; supabase_provider_id: string | null }>(
        `/v1/sso/connections/${encodeURIComponent(id)}/activate`,
        {},
      );
      return { ok: body.ok, supabaseProviderId: body.supabase_provider_id };
    },

    async enforce(action: SsoEnforceAction) {
      const { body } = await postFn<SsoEnforceResultWire>("/v1/sso/enforce", { action });
      return {
        ok: body.ok,
        action: body.action,
        enforceSso: body.enforce_sso,
        enforceSsoAt: body.enforce_sso_at,
      };
    },

    async getStatus() {
      const { body } = await getFn<{ readiness: SsoReadinessWire }>("/v1/sso/status");
      return wireToSsoReadiness(body.readiness);
    },

    async listJitRules(connectionId?: string) {
      const qs = connectionId ? new URLSearchParams({ connection_id: connectionId }) : undefined;
      const { body } = await getFn<{ rules: SsoJitRuleWire[] }>("/v1/sso/jit-rules", qs);
      return { rules: (body.rules ?? []).map(wireToSsoJitRule) };
    },

    async createJitRule(input: SsoJitRuleInput) {
      const payload: Record<string, unknown> = {
        connection_id: input.connectionId,
        claim_attribute: input.claimAttribute,
        claim_value: input.claimValue,
        granted_role: input.grantedRole,
      };
      if (input.precedence !== undefined) payload["precedence"] = input.precedence;
      const { body } = await postFn<SsoJitRuleWire>("/v1/sso/jit-rules", payload);
      return wireToSsoJitRule(body);
    },

    async patchJitRule(id: string, patch: SsoJitRulePatch) {
      const payload: Record<string, unknown> = {};
      if (patch.claimAttribute !== undefined) payload["claim_attribute"] = patch.claimAttribute;
      if (patch.claimValue !== undefined)     payload["claim_value"]     = patch.claimValue;
      if (patch.grantedRole !== undefined)    payload["granted_role"]    = patch.grantedRole;
      if (patch.precedence !== undefined)     payload["precedence"]      = patch.precedence;
      if (patch.isActive !== undefined)       payload["is_active"]       = patch.isActive;
      const { body } = await patchFn<SsoJitRuleWire>(
        `/v1/sso/jit-rules/${encodeURIComponent(id)}`,
        payload,
      );
      return wireToSsoJitRule(body);
    },

    async deleteJitRule(id: string) {
      await deleteFn(`/v1/sso/jit-rules/${encodeURIComponent(id)}`);
    },
  };
}
