import { describe, expect, it, vi } from "vitest";

import { makeAuthClient } from "../src/auth.js";

function makeMocks() {
  const postFn = vi.fn();
  const getFn  = vi.fn();
  const auth = makeAuthClient(postFn as never, getFn as never);
  return { auth, postFn, getFn };
}

const WIRE_TOKEN = {
  access_token: "at_abc",
  refresh_token: "rt_xyz",
  token_type: "Bearer",
  expires_in: 3600,
};

const WIRE_TOKEN_WITH_SCOPE = {
  ...WIRE_TOKEN,
  scope: "openid profile",
  idp_id: "idp_okta_prod",
};

describe("auth.refresh", () => {
  it("POSTs to /v1/auth/token/refresh with correct body", async () => {
    const { auth, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: WIRE_TOKEN });
    await auth.refresh("rt_current");
    expect(postFn).toHaveBeenCalledWith("/v1/auth/token/refresh", {
      refresh_token: "rt_current",
      grant_type: "refresh_token",
    });
  });

  it("maps wire snake_case to camelCase", async () => {
    const { auth, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: WIRE_TOKEN });
    const result = await auth.refresh("rt_current");
    expect(result.accessToken).toBe("at_abc");
    expect(result.refreshToken).toBe("rt_xyz");
    expect(result.tokenType).toBe("Bearer");
    expect(result.expiresIn).toBe(3600);
  });

  it("surfaces optional scope and idpId when present", async () => {
    const { auth, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: WIRE_TOKEN_WITH_SCOPE });
    const result = await auth.refresh("rt_current");
    expect(result.scope).toBe("openid profile");
    expect(result.idpId).toBe("idp_okta_prod");
  });

  it("does not include scope/idpId keys when absent on wire", async () => {
    const { auth, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: WIRE_TOKEN });
    const result = await auth.refresh("rt_current");
    expect(Object.keys(result)).not.toContain("scope");
    expect(Object.keys(result)).not.toContain("idpId");
  });
});

describe("auth.refreshWithIdp", () => {
  it("POSTs to /v1/auth/idp/{idpId}/token/refresh", async () => {
    const { auth, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: WIRE_TOKEN_WITH_SCOPE });
    await auth.refreshWithIdp("idp_okta_prod", "rt_current");
    expect(postFn.mock.calls[0]![0] as string).toBe("/v1/auth/idp/idp_okta_prod/token/refresh");
  });

  it("URL-encodes idpId", async () => {
    const { auth, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: WIRE_TOKEN });
    await auth.refreshWithIdp("idp/entra", "rt_current");
    expect(postFn.mock.calls[0]![0] as string).toContain("idp%2Fentra");
  });

  it("includes idp_id in request body", async () => {
    const { auth, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: WIRE_TOKEN });
    await auth.refreshWithIdp("idp_okta", "rt_current");
    expect(postFn.mock.calls[0]![1]).toMatchObject({ idp_id: "idp_okta" });
  });

  it("maps response to camelCase", async () => {
    const { auth, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: WIRE_TOKEN_WITH_SCOPE });
    const result = await auth.refreshWithIdp("idp_okta", "rt_current");
    expect(result.accessToken).toBe("at_abc");
    expect(result.idpId).toBe("idp_okta_prod");
  });
});

describe("auth.listIdpConnections", () => {
  const WIRE_CONN = {
    id: "idp_okta_prod",
    name: "Okta Production",
    provider: "okta",
    enabled: true,
    default: true,
    domains: ["example.com"],
    created_at: "2025-01-01T00:00:00Z",
  };

  it("GETs /v1/auth/idp-connections", async () => {
    const { auth, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: { connections: [WIRE_CONN] } });
    await auth.listIdpConnections();
    expect(getFn).toHaveBeenCalledWith("/v1/auth/idp-connections");
  });

  it("maps connection wire to camelCase", async () => {
    const { auth, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: { connections: [WIRE_CONN] } });
    const result = await auth.listIdpConnections();
    expect(result).toHaveLength(1);
    const conn = result[0]!;
    expect(conn.id).toBe("idp_okta_prod");
    expect(conn.isDefault).toBe(true);
    expect(conn.createdAt).toBe("2025-01-01T00:00:00Z");
    expect(conn.domains).toEqual(["example.com"]);
  });

  it("returns empty array when connections is empty", async () => {
    const { auth, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: { connections: [] } });
    expect(await auth.listIdpConnections()).toEqual([]);
  });

  it("returns empty array when connections key is absent", async () => {
    const { auth, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: {} });
    expect(await auth.listIdpConnections()).toEqual([]);
  });

  it("omits domains key when not present on wire", async () => {
    const { auth, getFn } = makeMocks();
    const connNoDomains = { ...WIRE_CONN, domains: undefined };
    getFn.mockResolvedValue({ body: { connections: [connNoDomains] } });
    const [conn] = await auth.listIdpConnections();
    expect(Object.keys(conn!)).not.toContain("domains");
  });
});
