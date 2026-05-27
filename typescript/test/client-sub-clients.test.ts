/**
 * Integration tests for scim / evidenceBundles / auth sub-clients accessed
 * through AtlaSentClient. These exercise the private adapter methods
 * (_post, _get, _put, _delete, _getRaw, _requestRaw) in client.ts.
 */

import { describe, expect, it, vi, type MockedFunction } from "vitest";

import { AtlaSentClient, AtlaSentError } from "../src/index.js";

type FetchMock = MockedFunction<typeof fetch>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-Request-ID": "req_test" },
  });
}

function mockFetch(
  impl: (url: string, init: RequestInit) => Response | Promise<Response>,
): FetchMock {
  return vi.fn(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      return impl(url, init ?? {});
    },
  ) as unknown as FetchMock;
}

function makeClient(fetchImpl: FetchMock) {
  return new AtlaSentClient({
    apiKey: "ask_live_test",
    fetch: fetchImpl,
    timeoutMs: 5_000,
    retryPolicy: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
  });
}

const WIRE_USER = {
  id: "usr_1",
  userName: "alice@example.com",
  active: true,
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
};

const WIRE_BUNDLE = {
  bundle_id: "bnd_abc",
  org_id: "org_xyz",
  incident_id: "inc_123",
  status: "pending",
  included_permits: [],
  include_overrides: false,
  format: "json",
  created_at: "2026-01-01T00:00:00Z",
  expires_at: "2026-01-08T00:00:00Z",
};

const WIRE_TOKEN = {
  access_token: "at_new",
  refresh_token: "rt_new",
  token_type: "Bearer",
  expires_in: 3600,
};

// ── SCIM via AtlaSentClient ───────────────────────────────────────────────────

describe("client.scim.users.list", () => {
  it("hits GET /scim/v2/{orgId}/Users and returns Resources", async () => {
    const f = mockFetch(() =>
      jsonResponse({ schemas: [], totalResults: 1, startIndex: 1, itemsPerPage: 100, Resources: [WIRE_USER] }),
    );
    const client = makeClient(f);
    const page = await client.scim.users.list({ orgId: "org_abc" });
    expect(page.Resources[0]!.userName).toBe("alice@example.com");
    const url = f.mock.calls[0]![0] as string;
    expect(url).toContain("/scim/v2/org_abc/Users");
  });
});

describe("client.scim.users.create", () => {
  it("POSTs and returns the created user", async () => {
    const f = mockFetch(() => jsonResponse(WIRE_USER, 201));
    const client = makeClient(f);
    const user = await client.scim.users.create("org_abc", { userName: "alice@example.com" });
    expect(user.userName).toBe("alice@example.com");
    const [url, init] = f.mock.calls[0]!;
    expect(url as string).toContain("/scim/v2/org_abc/Users");
    expect(init?.method).toBe("POST");
  });
});

describe("client.scim.users.update", () => {
  it("PUTs to /scim/v2/{orgId}/Users/{id}", async () => {
    const f = mockFetch(() => jsonResponse(WIRE_USER));
    const client = makeClient(f);
    const user = await client.scim.users.update("org_abc", "usr_1", WIRE_USER);
    expect(user.id).toBe("usr_1");
    const [url, init] = f.mock.calls[0]!;
    expect(url as string).toContain("/scim/v2/org_abc/Users/usr_1");
    expect(init?.method).toBe("PUT");
  });

  it("throws AtlaSentError on 404", async () => {
    const f = mockFetch(() => jsonResponse({ error: "not found" }, 404));
    const client = makeClient(f);
    await expect(client.scim.users.update("org_abc", "usr_missing", WIRE_USER)).rejects.toBeInstanceOf(AtlaSentError);
  });

  it("throws AtlaSentError on 500", async () => {
    const f = mockFetch(() => jsonResponse({}, 500));
    const client = makeClient(f);
    await expect(client.scim.users.update("org_abc", "usr_1", WIRE_USER)).rejects.toBeInstanceOf(AtlaSentError);
  });
});

describe("client.scim.users.delete", () => {
  it("sends DELETE and completes without error", async () => {
    const f = mockFetch(() => new Response(null, { status: 204 }));
    const client = makeClient(f);
    await expect(client.scim.users.delete("org_abc", "usr_1")).resolves.toBeUndefined();
    expect(f.mock.calls[0]![1]?.method).toBe("DELETE");
  });

  it("throws AtlaSentError on 404", async () => {
    const f = mockFetch(() => jsonResponse({ error: "not found" }, 404));
    const client = makeClient(f);
    await expect(client.scim.users.delete("org_abc", "usr_missing")).rejects.toBeInstanceOf(AtlaSentError);
  });
});

// ── evidence bundles via AtlaSentClient ───────────────────────────────────────

describe("client.evidenceBundles.create", () => {
  it("POSTs to /v1/evidence-bundles and returns mapped bundle", async () => {
    const f = mockFetch(() => jsonResponse(WIRE_BUNDLE, 201));
    const client = makeClient(f);
    const bundle = await client.evidenceBundles.create({ incidentId: "inc_123" });
    expect(bundle.bundleId).toBe("bnd_abc");
    expect(bundle.incidentId).toBe("inc_123");
  });
});

describe("client.evidenceBundles.get", () => {
  it("GETs /v1/evidence-bundles/{id}", async () => {
    const f = mockFetch(() => jsonResponse(WIRE_BUNDLE));
    const client = makeClient(f);
    const bundle = await client.evidenceBundles.get("bnd_abc");
    expect(bundle.bundleId).toBe("bnd_abc");
    expect(f.mock.calls[0]![0] as string).toContain("/v1/evidence-bundles/bnd_abc");
  });

  it("throws AtlaSentError on 404", async () => {
    const f = mockFetch(() => jsonResponse({ error: "not found" }, 404));
    const client = makeClient(f);
    await expect(client.evidenceBundles.get("bnd_missing")).rejects.toBeInstanceOf(AtlaSentError);
  });
});

describe("client.evidenceBundles.download", () => {
  it("GETs the download URL and returns a Buffer", async () => {
    const data = new Uint8Array([1, 2, 3]);
    const f = mockFetch(() => new Response(data.buffer));
    const client = makeClient(f);
    const buf = await client.evidenceBundles.download("bnd_abc", "json");
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf[0]).toBe(1);
  });

  it("throws AtlaSentError on non-ok response", async () => {
    const f = mockFetch(() => new Response("Forbidden", { status: 403 }));
    const client = makeClient(f);
    await expect(client.evidenceBundles.download("bnd_abc")).rejects.toBeInstanceOf(AtlaSentError);
  });
});

// ── auth via AtlaSentClient ───────────────────────────────────────────────────

describe("client.auth.refresh", () => {
  it("POSTs to /v1/auth/token/refresh and returns token", async () => {
    const f = mockFetch(() => jsonResponse(WIRE_TOKEN));
    const client = makeClient(f);
    const token = await client.auth.refresh("rt_current");
    expect(token.accessToken).toBe("at_new");
    expect(f.mock.calls[0]![0] as string).toContain("/v1/auth/token/refresh");
  });
});

describe("client.auth.refreshWithIdp", () => {
  it("POSTs to the correct IdP path", async () => {
    const f = mockFetch(() => jsonResponse(WIRE_TOKEN));
    const client = makeClient(f);
    const token = await client.auth.refreshWithIdp("idp_okta", "rt_current");
    expect(token.accessToken).toBe("at_new");
    expect(f.mock.calls[0]![0] as string).toContain("/v1/auth/idp/idp_okta/token/refresh");
  });
});

describe("client.auth.listIdpConnections", () => {
  it("GETs /v1/auth/idp-connections and returns connections", async () => {
    const f = mockFetch(() =>
      jsonResponse({
        connections: [
          { id: "idp_1", name: "Okta", provider: "okta", enabled: true, default: true, created_at: "2025-01-01T00:00:00Z" },
        ],
      }),
    );
    const client = makeClient(f);
    const conns = await client.auth.listIdpConnections();
    expect(conns).toHaveLength(1);
    expect(conns[0]!.id).toBe("idp_1");
    expect(conns[0]!.isDefault).toBe(true);
  });
});
