/**
 * SSO wire types — mirrors the v1-sso edge function in atlasent-api.
 *
 * These are READ-ONLY contract types. SSO administration lives behind
 * the org-admin role in the console; the SDK exposes the types so
 * downstream tooling (e.g. SCIM importers, IdP-side validators) can
 * deserialize the API responses with confidence.
 *
 * Source of truth: `supabase/functions/v1-sso/handler.ts` and
 * `supabase/migrations/0041_sso_connections.sql` in atlasent-api.
 */

/**
 * One SAML or OIDC connection per row of `sso_connections`.
 *
 * `client_secret` is intentionally absent from this shape — it is
 * write-only and never returned by the API.
 */
export interface SsoConnection {
  id: string;
  organization_id: string;
  name: string;
  protocol: 'saml' | 'oidc';
  is_active: boolean;
  status: 'active' | 'inactive' | 'deleted';
  /** SAML: caller-supplied IdP metadata URL. */
  metadata_url: string | null;
  /** SAML: IdP entity_id (issuer). */
  entity_id: string | null;
  /** SAML: server-generated AtlaSent SP entity_id; shown to admins. */
  sp_entity_id: string | null;
  /** SAML: server-generated ACS endpoint; shown to admins. */
  acs_url: string | null;
  /** OIDC: issuer URL. */
  issuer: string | null;
  /** OIDC: client_id. client_secret is write-only. */
  client_id: string | null;
  /** Domains this connection authoritatively claims. */
  domains: string[];
  /** When true, every login from one of `domains` MUST go through this connection. */
  enforce_for_domain: boolean;
  /** Role granted when no JIT rule matches. */
  default_role: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * One JIT (just-in-time) provisioning rule per row of
 * `sso_jit_provisioning_rules`. Rules are evaluated in ascending
 * `precedence` order; the first match wins. No-match falls through
 * to the connection's `default_role` (or fail-closed when no default
 * is set).
 */
export interface SsoJitRule {
  id: string;
  connection_id: string;
  organization_id: string;
  /** Dot path into the IdP claims object, e.g. `groups`, `custom.department`. */
  claim_path: string;
  /**
   * `equals`     — strict equality on the claim value
   * `contains`   — substring / array-includes match
   * `regex`      — JavaScript regex match against the stringified value
   * `in`         — exact match of any element in the value array
   */
  operator: 'equals' | 'contains' | 'regex' | 'in';
  /** `string` for equals / contains / regex; `string[]` for `in`. */
  value: string | string[];
  /** AtlaSent role to grant on a match. Aligned with org_members. */
  granted_role: string;
  /** Lower wins. */
  precedence: number;
  created_at: string;
  updated_at: string;
}

/**
 * A single login attempt recorded by the post-assertion hook.
 *
 * `sso_events` has bounded retention — `audit_events` carries the
 * immutable evidence copy that enters the Ed25519-signed export.
 */
export interface SsoEvent {
  id: string;
  organization_id: string;
  connection_id: string | null;
  occurred_at: string;
  outcome: 'login_success' | 'login_denied' | 'error' | 'connection_changed';
  user_id: string | null;
  email: string | null;
  /** Subset of the IdP assertion claims, redacted by the handler. */
  claims: Record<string, unknown> | null;
  matched_rule_id: string | null;
  granted_role: string | null;
  error_code: string | null;
  ip: string | null;
  user_agent: string | null;
}
