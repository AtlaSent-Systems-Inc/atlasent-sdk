import { describe, expect, it, vi } from "vitest";

import { makeSsoClient } from "../src/sso.js";

function makeMocks() {
  const getFn    = vi.fn();
  const postFn   = vi.fn();
  const patchFn  = vi.fn();
  const deleteFn = vi.fn();
  const sso = makeSsoClient(
    getFn   as never,
    postFn  as never,
    patchFn as never,
    deleteFn as never,
  );
  return { sso, getFn, postFn, patchFn, deleteFn };
}

const WIRE_CONNECTION = {
  id: "conn-1",
  organization_id: "org-1",
  name: "Okta SAML",
  protocol: "saml" as const,
  idp_entity_id: "https://idp.okta.com",
  metadata_url: "https://idp.okta.com/metadata",
  metadata_xml: null,
  email_domain: "acme.com",
  enforce_for_domain: false,
  is_active: true,
  supabase_provider_id: "prov-abc",
  created_by: "user-1",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
};

const CAMEL_CONNECTION = {
  id: "conn-1",
  organizationId: "org-1",
  name: "Okta SAML",
  protocol: "saml",
  idpEntityId: "https://idp.okta.com",
  metadataUrl: "https://idp.okta.com/metadata",
  metadataXml: null,
  emailDomain: "acme.com",
  enforceForDomain: false,
  isActive: true,
  supabaseProviderId: "prov-abc",
  createdBy: "user-1",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
};

// ── listConnections ──────────────────────────────────────────────────────────

describe("sso.listConnections", () => {
  it("GETs /v1/sso/connections", async () => {
    const { sso, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: { connections: [WIRE_CONNECTION] } });
    await sso.listConnections();
    expect(getFn.mock.calls[0]![0]).toBe("/v1/sso/connections");
  });

  it("maps wire connections to camelCase", async () => {
    const { sso, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: { connections: [WIRE_CONNECTION] } });
    const { connections } = await sso.listConnections();
    expect(connections[0]).toEqual(CAMEL_CONNECTION);
  });

  it("returns empty array when connections is absent", async () => {
    const { sso, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: {} });
    const { connections } = await sso.listConnections();
    expect(connections).toEqual([]);
  });
});

// ── getConnection ────────────────────────────────────────────────────────────

describe("sso.getConnection", () => {
  it("GETs /v1/sso/connections/:id", async () => {
    const { sso, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: WIRE_CONNECTION });
    await sso.getConnection("conn-1");
    expect(getFn.mock.calls[0]![0]).toBe("/v1/sso/connections/conn-1");
  });

  it("URL-encodes the id", async () => {
    const { sso, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: WIRE_CONNECTION });
    await sso.getConnection("conn/slash");
    expect(getFn.mock.calls[0]![0]).toContain("conn%2Fslash");
  });

  it("maps wire to camelCase", async () => {
    const { sso, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: WIRE_CONNECTION });
    const conn = await sso.getConnection("conn-1");
    expect(conn).toEqual(CAMEL_CONNECTION);
  });
});

// ── createConnection ─────────────────────────────────────────────────────────

describe("sso.createConnection", () => {
  it("POSTs to /v1/sso/connections", async () => {
    const { sso, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: WIRE_CONNECTION });
    await sso.createConnection({
      name: "Okta SAML",
      protocol: "saml",
      idpEntityId: "https://idp.okta.com",
    });
    expect(postFn).toHaveBeenCalledWith("/v1/sso/connections", expect.objectContaining({
      name: "Okta SAML",
      protocol: "saml",
      idp_entity_id: "https://idp.okta.com",
    }));
  });

  it("includes optional fields when provided", async () => {
    const { sso, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: WIRE_CONNECTION });
    await sso.createConnection({
      name: "Okta",
      protocol: "saml",
      idpEntityId: "https://idp.okta.com",
      emailDomain: "acme.com",
      enforceForDomain: true,
      metadataUrl: "https://idp.okta.com/metadata",
    });
    const body = postFn.mock.calls[0]![1] as Record<string, unknown>;
    expect(body["email_domain"]).toBe("acme.com");
    expect(body["enforce_for_domain"]).toBe(true);
    expect(body["metadata_url"]).toBe("https://idp.okta.com/metadata");
  });

  it("omits undefined optional fields", async () => {
    const { sso, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: WIRE_CONNECTION });
    await sso.createConnection({ name: "X", protocol: "oidc", idpEntityId: "e" });
    const body = postFn.mock.calls[0]![1] as Record<string, unknown>;
    expect(Object.keys(body)).not.toContain("email_domain");
    expect(Object.keys(body)).not.toContain("metadata_url");
  });

  it("returns camelCase connection", async () => {
    const { sso, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: WIRE_CONNECTION });
    const conn = await sso.createConnection({ name: "X", protocol: "saml", idpEntityId: "e" });
    expect(conn.organizationId).toBe("org-1");
    expect(conn.idpEntityId).toBe("https://idp.okta.com");
  });
});

// ── updateConnection ─────────────────────────────────────────────────────────

describe("sso.updateConnection", () => {
  it("PATCHes /v1/sso/connections/:id", async () => {
    const { sso, patchFn } = makeMocks();
    patchFn.mockResolvedValue({ body: WIRE_CONNECTION });
    await sso.updateConnection("conn-1", { name: "New Name" });
    expect(patchFn).toHaveBeenCalledWith("/v1/sso/connections/conn-1", { name: "New Name" });
  });

  it("URL-encodes the id", async () => {
    const { sso, patchFn } = makeMocks();
    patchFn.mockResolvedValue({ body: WIRE_CONNECTION });
    await sso.updateConnection("conn/x", { name: "X" });
    expect(patchFn.mock.calls[0]![0]).toContain("conn%2Fx");
  });

  it("maps snake_case fields in the patch body", async () => {
    const { sso, patchFn } = makeMocks();
    patchFn.mockResolvedValue({ body: WIRE_CONNECTION });
    await sso.updateConnection("conn-1", { emailDomain: "new.com", enforceForDomain: true });
    const body = patchFn.mock.calls[0]![1] as Record<string, unknown>;
    expect(body["email_domain"]).toBe("new.com");
    expect(body["enforce_for_domain"]).toBe(true);
  });

  it("returns camelCase connection", async () => {
    const { sso, patchFn } = makeMocks();
    patchFn.mockResolvedValue({ body: WIRE_CONNECTION });
    const conn = await sso.updateConnection("conn-1", {});
    expect(conn).toEqual(CAMEL_CONNECTION);
  });
});

// ── deleteConnection ─────────────────────────────────────────────────────────

describe("sso.deleteConnection", () => {
  it("DELETEs /v1/sso/connections/:id", async () => {
    const { sso, deleteFn } = makeMocks();
    deleteFn.mockResolvedValue(undefined);
    await sso.deleteConnection("conn-1");
    expect(deleteFn).toHaveBeenCalledWith("/v1/sso/connections/conn-1");
  });

  it("URL-encodes the id", async () => {
    const { sso, deleteFn } = makeMocks();
    deleteFn.mockResolvedValue(undefined);
    await sso.deleteConnection("conn/x");
    expect(deleteFn.mock.calls[0]![0]).toContain("conn%2Fx");
  });
});

// ── activateConnection ───────────────────────────────────────────────────────

describe("sso.activateConnection", () => {
  it("POSTs to /v1/sso/connections/:id/activate", async () => {
    const { sso, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: { ok: true, supabase_provider_id: "prov-abc" } });
    await sso.activateConnection("conn-1");
    expect(postFn).toHaveBeenCalledWith("/v1/sso/connections/conn-1/activate", {});
  });

  it("URL-encodes the id", async () => {
    const { sso, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: { ok: true, supabase_provider_id: null } });
    await sso.activateConnection("conn/x");
    expect(postFn.mock.calls[0]![0]).toContain("conn%2Fx");
  });

  it("maps supabase_provider_id → supabaseProviderId", async () => {
    const { sso, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: { ok: true, supabase_provider_id: "prov-abc" } });
    const result = await sso.activateConnection("conn-1");
    expect(result.ok).toBe(true);
    expect(result.supabaseProviderId).toBe("prov-abc");
  });

  it("passes through null supabaseProviderId", async () => {
    const { sso, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: { ok: false, supabase_provider_id: null } });
    const result = await sso.activateConnection("conn-1");
    expect(result.supabaseProviderId).toBeNull();
  });
});

// ── enforce ──────────────────────────────────────────────────────────────────

describe("sso.enforce", () => {
  it("POSTs { action } to /v1/sso/enforce", async () => {
    const { sso, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: { ok: true, action: "enable", enforce_sso: false, enforce_sso_at: null } });
    await sso.enforce("enable");
    expect(postFn).toHaveBeenCalledWith("/v1/sso/enforce", { action: "enable" });
  });

  it("maps wire fields to camelCase", async () => {
    const { sso, postFn } = makeMocks();
    postFn.mockResolvedValue({
      body: { ok: true, action: "enforce", enforce_sso: true, enforce_sso_at: "2026-01-01T00:00:00Z" },
    });
    const result = await sso.enforce("enforce");
    expect(result.ok).toBe(true);
    expect(result.action).toBe("enforce");
    expect(result.enforceSso).toBe(true);
    expect(result.enforceSsoAt).toBe("2026-01-01T00:00:00Z");
  });

  it("passes null enforceSsoAt through", async () => {
    const { sso, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: { ok: true, action: "enable", enforce_sso: false, enforce_sso_at: null } });
    const result = await sso.enforce("enable");
    expect(result.enforceSsoAt).toBeNull();
  });
});

// ── getStatus ────────────────────────────────────────────────────────────────

describe("sso.getStatus", () => {
  it("GETs /v1/sso/status", async () => {
    const { sso, getFn } = makeMocks();
    getFn.mockResolvedValue({
      body: {
        readiness: {
          connection_configured: true,
          connection_tested: false,
          break_glass_set: false,
          service_api_keys_reviewed: true,
        },
      },
    });
    await sso.getStatus();
    expect(getFn.mock.calls[0]![0]).toBe("/v1/sso/status");
  });

  it("maps readiness wire to camelCase", async () => {
    const { sso, getFn } = makeMocks();
    getFn.mockResolvedValue({
      body: {
        readiness: {
          connection_configured: true,
          connection_tested: true,
          break_glass_set: false,
          service_api_keys_reviewed: true,
        },
      },
    });
    const result = await sso.getStatus();
    expect(result.connectionConfigured).toBe(true);
    expect(result.connectionTested).toBe(true);
    expect(result.breakGlassSet).toBe(false);
    expect(result.serviceApiKeysReviewed).toBe(true);
  });
});
