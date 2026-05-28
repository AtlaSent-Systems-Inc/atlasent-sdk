import { describe, expect, it, vi } from "vitest";

import { makeAccessGovernanceLogClient } from "../src/access-governance-log.js";

function makeMocks() {
  const getFn = vi.fn();
  const client = makeAccessGovernanceLogClient(getFn as never);
  return { client, getFn };
}

const WIRE_EVENT = {
  id: "evt-1",
  event_type: "sso.login",
  org_id: "org-1",
  actor_id: null,
  actor_email: "alice@acme.com",
  ip_address: "1.2.3.4",
  metadata: { connection_id: "conn-1" },
  created_at: "2026-01-01T00:00:00Z",
};

const CAMEL_EVENT = {
  id: "evt-1",
  eventType: "sso.login",
  orgId: "org-1",
  actorId: null,
  actorEmail: "alice@acme.com",
  ipAddress: "1.2.3.4",
  metadata: { connection_id: "conn-1" },
  createdAt: "2026-01-01T00:00:00Z",
};

const WIRE_RESPONSE = {
  events: [WIRE_EVENT],
  next_cursor: "2026-01-01T00:00:00Z",
  total_count: 42,
};

// ── list ──────────────────────────────────────────────────────────────────────

describe("accessGovernanceLog.list", () => {
  it("GETs /v1/access-governance-log with no params", async () => {
    const { client, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: WIRE_RESPONSE });
    await client.list();
    expect(getFn.mock.calls[0]![0]).toBe("/v1/access-governance-log");
    expect(getFn.mock.calls[0]![1]).toBeUndefined();
  });

  it("maps wire events to camelCase", async () => {
    const { client, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: WIRE_RESPONSE });
    const page = await client.list();
    expect(page.events[0]).toEqual(CAMEL_EVENT);
  });

  it("maps next_cursor and total_count", async () => {
    const { client, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: WIRE_RESPONSE });
    const page = await client.list();
    expect(page.nextCursor).toBe("2026-01-01T00:00:00Z");
    expect(page.totalCount).toBe(42);
  });

  it("returns null nextCursor when no more pages", async () => {
    const { client, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: { events: [], next_cursor: null, total_count: 0 } });
    const page = await client.list();
    expect(page.nextCursor).toBeNull();
    expect(page.totalCount).toBe(0);
  });

  it("passes limit as query param", async () => {
    const { client, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: WIRE_RESPONSE });
    await client.list({ limit: 100 });
    const qs = getFn.mock.calls[0]![1] as URLSearchParams;
    expect(qs.get("limit")).toBe("100");
  });

  it("passes cursor as query param", async () => {
    const { client, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: WIRE_RESPONSE });
    await client.list({ cursor: "2026-01-01T00:00:00Z" });
    const qs = getFn.mock.calls[0]![1] as URLSearchParams;
    expect(qs.get("cursor")).toBe("2026-01-01T00:00:00Z");
  });

  it("passes event_type filter", async () => {
    const { client, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: WIRE_RESPONSE });
    await client.list({ eventType: "sso.login" });
    const qs = getFn.mock.calls[0]![1] as URLSearchParams;
    expect(qs.get("event_type")).toBe("sso.login");
  });

  it("passes actor_id filter", async () => {
    const { client, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: WIRE_RESPONSE });
    await client.list({ actorId: "alice@acme.com" });
    const qs = getFn.mock.calls[0]![1] as URLSearchParams;
    expect(qs.get("actor_id")).toBe("alice@acme.com");
  });

  it("passes from/to filters", async () => {
    const { client, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: WIRE_RESPONSE });
    await client.list({ from: "2026-01-01T00:00:00Z", to: "2026-12-31T23:59:59Z" });
    const qs = getFn.mock.calls[0]![1] as URLSearchParams;
    expect(qs.get("from")).toBe("2026-01-01T00:00:00Z");
    expect(qs.get("to")).toBe("2026-12-31T23:59:59Z");
  });

  it("omits query string when no params given", async () => {
    const { client, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: { events: [], next_cursor: null, total_count: 0 } });
    await client.list({});
    expect(getFn.mock.calls[0]![1]).toBeUndefined();
  });

  it("returns empty events array when absent from wire", async () => {
    const { client, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: { next_cursor: null, total_count: 0 } });
    const page = await client.list();
    expect(page.events).toEqual([]);
  });

  it("defaults totalCount to 0 when absent from wire", async () => {
    const { client, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: { events: [], next_cursor: null } });
    const page = await client.list();
    expect(page.totalCount).toBe(0);
  });

  it("null ip_address passes through", async () => {
    const { client, getFn } = makeMocks();
    getFn.mockResolvedValue({
      body: {
        events: [{ ...WIRE_EVENT, ip_address: null }],
        next_cursor: null,
        total_count: 1,
      },
    });
    const page = await client.list();
    expect(page.events[0]!.ipAddress).toBeNull();
  });
});
