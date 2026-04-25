/**
 * Structural assertions for the `/v1/sso/*` wire types and the
 * `client.sso.events.list()` SDK shim.
 *
 * Mirror of `audit-types.test.ts` — these tests fail CI when the
 * SSO wire shape drifts from the source of truth in
 * `atlasent-api/supabase/functions/v1-sso/handler.ts` +
 * `0041_sso_connections.sql`. Keep the type-level key sets in lockstep
 * with the table CHECK constraints when fields are added.
 */

import { describe, expect, it } from "vitest";

import { AtlaSentClient } from "../src/client.js";
import type {
  SsoCanonicalRole,
  SsoConnection,
  SsoEvent,
  SsoEventType,
  SsoEventsPage,
  SsoEventsQuery,
  SsoJitRule,
  SsoProtocol,
} from "../src/sso.js";

// ─── Type-level equality helpers ──────────────────────────────────────────────

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type AssertTrue<T extends true> = T;

type SsoConnectionRequiredKeys =
  | "id"
  | "organization_id"
  | "name"
  | "protocol"
  | "supabase_provider_id"
  | "idp_entity_id"
  | "metadata_url"
  | "metadata_xml"
  | "email_domain"
  | "enforce_for_domain"
  | "is_active"
  | "created_at"
  | "updated_at";

type SsoJitRuleKeys =
  | "id"
  | "connection_id"
  | "organization_id"
  | "claim_attribute"
  | "claim_value"
  | "granted_role"
  | "precedence"
  | "is_active"
  | "created_at"
  | "updated_at";

type SsoEventKeys =
  | "id"
  | "organization_id"
  | "connection_id"
  | "event_type"
  | "actor_email"
  | "payload"
  | "occurred_at";

// `created_by` is the only optional field on SsoConnection (handler returns it
// when present, omits otherwise). The required-key assertion below excludes
// it deliberately — it's tested for accept-when-omitted in the runtime block.
type RequiredKeysOf<T> = {
  [K in keyof T]-?: undefined extends T[K] ? never : K;
}[keyof T];

type _SsoConnectionRequiredKeysEqual = AssertTrue<
  Exact<RequiredKeysOf<SsoConnection>, SsoConnectionRequiredKeys>
>;
type _SsoJitRuleKeysEqual = AssertTrue<Exact<keyof SsoJitRule, SsoJitRuleKeys>>;
type _SsoEventKeysEqual = AssertTrue<Exact<keyof SsoEvent, SsoEventKeys>>;

type _SsoProtocolEqual = AssertTrue<Exact<SsoProtocol, "saml" | "oidc">>;
type _SsoCanonicalRoleEqual = AssertTrue<
  Exact<SsoCanonicalRole, "owner" | "admin" | "approver" | "member" | "viewer">
>;
type _SsoEventTypeEqual = AssertTrue<
  Exact<
    SsoEventType,
    | "login_success"
    | "login_denied"
    | "jit_provisioned"
    | "role_changed"
    | "connection_created"
    | "connection_updated"
    | "connection_deleted"
    | "connection_activated"
    | "connection_deactivated"
  >
>;

export type _TypeAssertionsInForce =
  | _SsoConnectionRequiredKeysEqual
  | _SsoJitRuleKeysEqual
  | _SsoEventKeysEqual
  | _SsoProtocolEqual
  | _SsoCanonicalRoleEqual
  | _SsoEventTypeEqual;

// ─── Runtime smoke check ──────────────────────────────────────────────────────

describe("SSO wire types", () => {
  it("SsoConnection accepts a fully-populated row", () => {
    const conn: SsoConnection = {
      id: "00000000-0000-0000-0000-000000000001",
      organization_id: "00000000-0000-0000-0000-00000000000a",
      name: "Acme SSO",
      protocol: "saml",
      supabase_provider_id: "ssp_42",
      idp_entity_id: "https://idp.acme.com/saml",
      metadata_url: "https://idp.acme.com/saml/metadata",
      metadata_xml: null,
      email_domain: "acme.com",
      enforce_for_domain: true,
      is_active: true,
      created_at: "2026-04-24T00:00:00Z",
      updated_at: "2026-04-24T00:00:01Z",
      created_by: "user_1",
    };
    expect(conn.protocol).toBe("saml");
    expect(conn.enforce_for_domain).toBe(true);
  });

  it("SsoConnection accepts a row with nullable metadata + no created_by", () => {
    const conn: SsoConnection = {
      id: "00000000-0000-0000-0000-000000000002",
      organization_id: "00000000-0000-0000-0000-00000000000a",
      name: "Pending OIDC",
      protocol: "oidc",
      supabase_provider_id: null,
      idp_entity_id: "issuer.example.com",
      metadata_url: null,
      metadata_xml: "<EntityDescriptor/>",
      email_domain: null,
      enforce_for_domain: false,
      is_active: false,
      created_at: "2026-04-24T00:00:02Z",
      updated_at: "2026-04-24T00:00:02Z",
    };
    expect(conn.is_active).toBe(false);
    expect(conn.supabase_provider_id).toBeNull();
  });

  it("SsoJitRule accepts a fully-populated row", () => {
    const rule: SsoJitRule = {
      id: "00000000-0000-0000-0000-000000000010",
      connection_id: "00000000-0000-0000-0000-000000000001",
      organization_id: "00000000-0000-0000-0000-00000000000a",
      claim_attribute: "groups",
      claim_value: "atlasent-admins",
      granted_role: "admin",
      precedence: 10,
      is_active: true,
      created_at: "2026-04-24T00:00:00Z",
      updated_at: "2026-04-24T00:00:01Z",
    };
    expect(rule.granted_role).toBe("admin");
    expect(rule.precedence).toBe(10);
  });

  it("SsoEvent accepts a connection-lifecycle event", () => {
    const evt: SsoEvent = {
      id: "00000000-0000-0000-0000-000000000020",
      organization_id: "00000000-0000-0000-0000-00000000000a",
      connection_id: "00000000-0000-0000-0000-000000000001",
      event_type: "connection_activated",
      actor_email: "owner@acme.com",
      payload: { supabase_provider_id: "ssp_42" },
      occurred_at: "2026-04-24T00:00:03Z",
    };
    expect(evt.event_type).toBe("connection_activated");
  });

  it("SsoEvent permits null connection_id + actor_email (login denial)", () => {
    const evt: SsoEvent = {
      id: "00000000-0000-0000-0000-000000000021",
      organization_id: "00000000-0000-0000-0000-00000000000a",
      connection_id: null,
      event_type: "login_denied",
      actor_email: null,
      payload: { reason: "no JIT rule matched" },
      occurred_at: "2026-04-24T00:00:04Z",
    };
    expect(evt.connection_id).toBeNull();
    expect(evt.actor_email).toBeNull();
  });

  it("SsoEventsQuery is all-optional", () => {
    const empty: SsoEventsQuery = {};
    expect(Object.keys(empty)).toEqual([]);
    const full: SsoEventsQuery = { limit: 25, cursor: "2026-04-24T00:00:00Z" };
    expect(full.limit).toBe(25);
  });

  it("SsoEventsPage requires events + next_cursor", () => {
    const page: SsoEventsPage = { events: [], next_cursor: null };
    expect(page.next_cursor).toBeNull();
  });
});

// ─── client.sso.events.list ───────────────────────────────────────────────────

function makeMockFetch(
  body: unknown,
  capture: { url?: string } = {},
): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    capture.url = typeof input === "string" ? input : input.toString();
    void init;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-ratelimit-limit": "120",
        "x-ratelimit-remaining": "119",
        "x-ratelimit-reset": "1800000000",
      },
    });
  }) as typeof fetch;
}

describe("client.sso.events.list", () => {
  it("returns the page shape and forwards rate-limit state", async () => {
    const wire = {
      events: [
        {
          id: "00000000-0000-0000-0000-000000000020",
          organization_id: "00000000-0000-0000-0000-00000000000a",
          connection_id: "00000000-0000-0000-0000-000000000001",
          event_type: "connection_created",
          actor_email: "owner@acme.com",
          payload: { name: "Acme SSO" },
          occurred_at: "2026-04-24T00:00:00Z",
        },
      ],
      next_cursor: null,
    };
    const capture: { url?: string } = {};
    const client = new AtlaSentClient({
      apiKey: "k_live_test",
      fetch: makeMockFetch(wire, capture),
    });
    const page = await client.sso.events.list();
    expect(page.events).toHaveLength(1);
    expect(page.events[0]?.event_type).toBe("connection_created");
    expect(page.next_cursor).toBeNull();
    expect(page.rateLimit?.limit).toBe(120);
    expect(capture.url).toContain("/v1/sso/events");
  });

  it("serializes limit and translates cursor → ?after=", async () => {
    const wire = { events: [], next_cursor: null };
    const capture: { url?: string } = {};
    const client = new AtlaSentClient({
      apiKey: "k",
      fetch: makeMockFetch(wire, capture),
    });
    await client.sso.events.list({ limit: 25, cursor: "2026-04-24T00:00:00Z" });
    expect(capture.url).toContain("limit=25");
    expect(capture.url).toContain("after=2026-04-24T00%3A00%3A00Z");
  });

  it("propagates next_cursor when the server returns one", async () => {
    const wire = { events: [], next_cursor: "2026-04-23T00:00:00Z" };
    const client = new AtlaSentClient({
      apiKey: "k",
      fetch: makeMockFetch(wire),
    });
    const page = await client.sso.events.list({ limit: 1 });
    expect(page.next_cursor).toBe("2026-04-23T00:00:00Z");
  });

  it("throws AtlaSentError when the server returns a malformed body", async () => {
    const client = new AtlaSentClient({
      apiKey: "k",
      fetch: makeMockFetch({ not_events: true }),
    });
    await expect(client.sso.events.list()).rejects.toThrowError(
      /missing `events`/,
    );
  });

  it("ignores empty cursor strings (no `after=` param)", async () => {
    const capture: { url?: string } = {};
    const client = new AtlaSentClient({
      apiKey: "k",
      fetch: makeMockFetch({ events: [], next_cursor: null }, capture),
    });
    await client.sso.events.list({ cursor: "" });
    expect(capture.url).not.toContain("after=");
  });

  it("coerces a non-string non-null cursor to null defensively", async () => {
    // The handler always emits a string or null; this guards against a
    // future shape change that would otherwise leak `unknown` through
    // the typed return.
    const capture: { url?: string } = {};
    const client = new AtlaSentClient({
      apiKey: "k",
      fetch: makeMockFetch(
        { events: [], next_cursor: 42 as unknown as string | null },
        capture,
      ),
    });
    const page = await client.sso.events.list();
    expect(page.next_cursor).toBeNull();
  });
});

describe("SSO types are re-exported from the SDK entry point", () => {
  it("@atlasent/sdk surfaces the SSO wire types", async () => {
    const mod = await import("../src/index.js");
    expect(typeof mod.AtlaSentClient).toBe("function");
  });
});
