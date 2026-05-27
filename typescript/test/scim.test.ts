import { describe, expect, it, vi } from "vitest";

import {
  makeScimClient,
  SCIM_USER_SCHEMA,
  SCIM_GROUP_SCHEMA,
} from "../src/scim.js";

function makeMocks() {
  const postFn = vi.fn();
  const getFn  = vi.fn();
  const putFn  = vi.fn();
  const delFn  = vi.fn();
  const scim = makeScimClient(
    postFn as never,
    getFn as never,
    putFn as never,
    delFn as never,
  );
  return { scim, postFn, getFn, putFn, delFn };
}

const STUB_USER = {
  id: "usr_1",
  userName: "alice@example.com",
  displayName: "Alice",
  active: true,
  schemas: [SCIM_USER_SCHEMA],
};

const STUB_LIST = {
  schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
  totalResults: 1,
  startIndex: 1,
  itemsPerPage: 100,
  Resources: [STUB_USER],
};

describe("scim.users.list", () => {
  it("calls GET with correct path and no query when params are minimal", async () => {
    const { scim, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: STUB_LIST });
    const result = await scim.users.list({ orgId: "org_abc" });
    expect(getFn).toHaveBeenCalledOnce();
    const [path, qs] = getFn.mock.calls[0] as [string, URLSearchParams | undefined];
    expect(path).toBe("/scim/v2/org_abc/Users");
    expect(qs).toBeUndefined();
    expect(result.Resources).toHaveLength(1);
  });

  it("passes filter / startIndex / count as URLSearchParams", async () => {
    const { scim, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: STUB_LIST });
    await scim.users.list({ orgId: "org_abc", filter: 'userName eq "alice"', startIndex: 2, count: 10 });
    const qs = getFn.mock.calls[0]![1] as URLSearchParams;
    expect(qs?.get("filter")).toBe('userName eq "alice"');
    expect(qs?.get("startIndex")).toBe("2");
    expect(qs?.get("count")).toBe("10");
  });

  it("URL-encodes orgId", async () => {
    const { scim, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: STUB_LIST });
    await scim.users.list({ orgId: "org/with/slashes" });
    expect(getFn.mock.calls[0]![0] as string).toContain("org%2Fwith%2Fslashes");
  });
});

describe("scim.users.create", () => {
  it("injects schemas if absent", async () => {
    const { scim, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: STUB_USER });
    await scim.users.create("org_abc", { userName: "bob@example.com", active: true });
    const payload = postFn.mock.calls[0]![1] as typeof STUB_USER;
    expect(payload.schemas).toContain(SCIM_USER_SCHEMA);
  });

  it("preserves caller-supplied schemas", async () => {
    const { scim, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: STUB_USER });
    const custom = ["urn:custom"];
    await scim.users.create("org_abc", { userName: "bob@example.com", schemas: custom });
    expect(postFn.mock.calls[0]![1]).toMatchObject({ schemas: custom });
  });
});

describe("scim.users.update", () => {
  it("calls PUT with orgId + userId path", async () => {
    const { scim, putFn } = makeMocks();
    putFn.mockResolvedValue({ body: STUB_USER });
    await scim.users.update("org_abc", "usr_1", STUB_USER);
    expect(putFn.mock.calls[0]![0] as string).toBe("/scim/v2/org_abc/Users/usr_1");
  });

  it("injects schemas on update if absent", async () => {
    const { scim, putFn } = makeMocks();
    putFn.mockResolvedValue({ body: STUB_USER });
    const user = { userName: "alice@example.com" };
    await scim.users.update("org_abc", "usr_1", user);
    expect((putFn.mock.calls[0]![1] as Record<string, unknown>).schemas).toContain(SCIM_USER_SCHEMA);
  });
});

describe("scim.users.delete", () => {
  it("calls DELETE with correct path", async () => {
    const { scim, delFn } = makeMocks();
    delFn.mockResolvedValue(undefined);
    await scim.users.delete("org_abc", "usr_1");
    expect(delFn).toHaveBeenCalledWith("/scim/v2/org_abc/Users/usr_1");
  });
});

describe("scim.groups.list", () => {
  const STUB_GROUP_LIST = { schemas: [], totalResults: 0, startIndex: 1, itemsPerPage: 100, Resources: [] };

  it("calls GET /scim/v2/{orgId}/Groups", async () => {
    const { scim, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: STUB_GROUP_LIST });
    await scim.groups.list({ orgId: "org_abc" });
    expect(getFn.mock.calls[0]![0] as string).toBe("/scim/v2/org_abc/Groups");
  });

  it("passes filter query param", async () => {
    const { scim, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: STUB_GROUP_LIST });
    await scim.groups.list({ orgId: "org_abc", filter: 'displayName eq "Admins"' });
    const qs = getFn.mock.calls[0]![1] as URLSearchParams | undefined;
    expect(qs?.get("filter")).toBe('displayName eq "Admins"');
  });
});

describe("scim.groups.create", () => {
  it("injects SCIM_GROUP_SCHEMA if absent", async () => {
    const { scim, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: { id: "grp_1" } });
    await scim.groups.create("org_abc", { displayName: "Admins" });
    expect((postFn.mock.calls[0]![1] as Record<string, unknown>).schemas).toContain(SCIM_GROUP_SCHEMA);
  });
});

describe("scim.groups.delete", () => {
  it("calls DELETE /scim/v2/{orgId}/Groups/{id}", async () => {
    const { scim, delFn } = makeMocks();
    delFn.mockResolvedValue(undefined);
    await scim.groups.delete("org_abc", "grp_1");
    expect(delFn).toHaveBeenCalledWith("/scim/v2/org_abc/Groups/grp_1");
  });
});
