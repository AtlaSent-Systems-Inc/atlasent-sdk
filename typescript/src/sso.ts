/**
 * Shared SSO wire types — the `/v1/sso/*` HTTP surface.
 *
 * Source of truth: `atlasent-api/supabase/functions/v1-sso/handler.ts`
 * (the edge function that serves SSO connections, JIT rules, and
 * the SSO event log) plus the table schemas in
 * `atlasent-api/supabase/migrations/0041_sso_connections.sql`. Field
 * names below match the wire JSON (snake_case) byte-for-byte so a
 * payload from the server can be assigned without translation.
 *
 * ⚠ Upstream sync TODO: these types should live in
 * `atlasent-api/packages/types/src/index.ts` (the canonical
 * `@atlasent/types` package). They are mirrored here in the SDK as a
 * stop-gap until the upstream PR lands; once the upstream symbols are
 * published this module should re-export from `@atlasent/types` so the
 * SDK stays a thin mirror like `./audit.ts` is for the audit surface.
 *
 * Like `./audit.ts`, this module is intentionally wire-identical: the
 * SSO admin surface returns persisted DB rows as-is and the SDK does
 * not translate them into a camelCase object.
 */

/**
 * Identity-provider protocol. Today the handler ships SAML; OIDC is
 * the planned second protocol and is enforced by the same CHECK
 * constraint (`protocol IN ('saml', 'oidc')`) as the table.
 */
export type SsoProtocol = "saml" | "oidc";

/**
 * Roles a JIT rule can grant. Aligned with `org_members.role` via
 * migration 0042. The `operator` and `auditor` legacy values are
 * present on the DB CHECK constraint but the handler restricts
 * `CANONICAL_ROLES` to the five values below — so the SDK union
 * tracks the handler, not the table.
 */
export type SsoCanonicalRole =
  | "owner"
  | "admin"
  | "approver"
  | "member"
  | "viewer";

/**
 * SSO event-type tags persisted into `sso_events.event_type`. Drawn
 * from the table CHECK constraint in `0041_sso_connections.sql` — the
 * handler currently emits a subset (the connection lifecycle plus
 * `login_denied`); the rest are reserved for the assertion-side
 * pathways (login_success, jit_provisioned, role_changed) which fire
 * from the Supabase post-assertion hook.
 */
export type SsoEventType =
  | "login_success"
  | "login_denied"
  | "jit_provisioned"
  | "role_changed"
  | "connection_created"
  | "connection_updated"
  | "connection_deleted"
  | "connection_activated"
  | "connection_deactivated";

/**
 * One row from `sso_connections`, as returned by
 * `GET /v1/sso/connections` and `GET /v1/sso/connections/:id`.
 *
 * `metadata_url` and `metadata_xml` are mutually-permissive (the table
 * CHECK requires at least one) — both can be `null` only on a row
 * being deactivated. `enforce_for_domain` is gated on the org's plan;
 * see the handler's free-tier check.
 */
export interface SsoConnection {
  /** Connection UUID. */
  id: string;
  /** Owning organization id. Wire field is `organization_id`. */
  organization_id: string;
  /** Display name shown on the org's login page. */
  name: string;
  /** Identity-provider protocol. */
  protocol: SsoProtocol;
  /**
   * Supabase Auth provider id, set after the connection is registered
   * via `POST /v1/sso/connections/:id/activate`. `null` while the
   * connection is still being bootstrapped.
   */
  supabase_provider_id: string | null;
  /** IdP-side identifier (SAML EntityID / OIDC issuer). */
  idp_entity_id: string;
  /** Either a metadata URL or inline metadata XML must be present. */
  metadata_url: string | null;
  /** Either a metadata URL or inline metadata XML must be present. */
  metadata_xml: string | null;
  /**
   * Email domain that routes a login to this connection ("acme.com"
   * matches `alice@acme.com`). `null` when the org wants the manual
   * IdP picker on the login page.
   */
  email_domain: string | null;
  /**
   * When `true`, all logins from `email_domain` MUST go through SSO;
   * the magic-link path is rejected. Enterprise-tier feature.
   */
  enforce_for_domain: boolean;
  /** `false` until the connection has been activated. */
  is_active: boolean;
  /** ISO 8601 timestamp of creation. */
  created_at: string;
  /** ISO 8601 timestamp of the last mutation. */
  updated_at: string;
  /** User id who created the row, when known. */
  created_by?: string | null;
}

/**
 * One row from `sso_jit_provisioning_rules`, as returned by
 * `GET /v1/sso/jit-rules` (optionally filtered by `connection_id`).
 *
 * Matching semantics: the rule fires when
 * `claims[claim_attribute]` contains `claim_value` (membership for
 * array-shaped claims, equality for scalars). When multiple rules
 * match, the lowest `precedence` wins; ties broken by row id for
 * determinism.
 */
export interface SsoJitRule {
  /** Rule UUID. */
  id: string;
  /** The connection this rule scopes to. */
  connection_id: string;
  /** Owning organization id. */
  organization_id: string;
  /**
   * The claim attribute to inspect on the IdP assertion. SAML usually
   * uses `groups` or `http://schemas.xmlsoap.org/claims/Group`; OIDC
   * usually uses `groups`.
   */
  claim_attribute: string;
  /** The literal value that must be present in the claim. */
  claim_value: string;
  /** AtlaSent role granted on the org when this rule wins. */
  granted_role: SsoCanonicalRole;
  /** Lower numbers win when multiple rules match. Default 100. */
  precedence: number;
  /** Inactive rules are skipped during evaluation. */
  is_active: boolean;
  /** ISO 8601 timestamp of creation. */
  created_at: string;
  /** ISO 8601 timestamp of the last mutation. */
  updated_at: string;
}

/**
 * One row from `sso_events`, as returned by `GET /v1/sso/events`.
 *
 * `connection_id` is nullable because a denial can fire before the
 * inbound assertion is mapped to a connection (e.g. unknown EntityID).
 * `actor_email` is nullable for system-actor events (e.g. a
 * connection being deactivated by an org-wide policy job).
 */
export interface SsoEvent {
  /** Event UUID. */
  id: string;
  /** Owning organization id. */
  organization_id: string;
  /** Connection the event references; `null` when not attributable. */
  connection_id: string | null;
  /** What happened. See {@link SsoEventType}. */
  event_type: SsoEventType;
  /** Email of the user the event concerns; `null` for system actors. */
  actor_email: string | null;
  /** Free-form structured payload. Always present (defaults to `{}`). */
  payload: Record<string, unknown>;
  /** ISO 8601 timestamp the event occurred. */
  occurred_at: string;
}

/**
 * Query parameters accepted by `GET /v1/sso/events`.
 *
 * `cursor` is the prior page's `next_cursor` (an ISO 8601 timestamp
 * the handler emits when more rows exist). `limit` defaults to 50,
 * capped at 200.
 */
export interface SsoEventsQuery {
  /** Page size. Default 50, capped at 200. */
  limit?: number;
  /** Opaque cursor returned as `next_cursor` by the prior page. */
  cursor?: string;
}

/**
 * Response shape for `GET /v1/sso/events`.
 *
 * `next_cursor` is `null` (not omitted) when the current page is the
 * last — the handler always includes the field so callers can write a
 * uniform pagination loop.
 */
export interface SsoEventsPage {
  events: SsoEvent[];
  next_cursor: string | null;
}
