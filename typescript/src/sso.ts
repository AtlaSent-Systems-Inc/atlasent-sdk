/**
 * SSO administration types — connections, JIT rules, events, and enforcement
 * readiness. These mirror the wire shapes served by the v1-sso edge function.
 *
 * Usage:
 *
 * ```ts
 * import type { SsoConnection, SsoReadiness } from "@atlasent/sdk";
 *
 * const res = await fetch("/functions/v1/v1-sso/connections", { ... });
 * const { connections } = await res.json() as { connections: SsoConnectionWire[] };
 * const typed = connections.map(wireToSsoConnection);
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
