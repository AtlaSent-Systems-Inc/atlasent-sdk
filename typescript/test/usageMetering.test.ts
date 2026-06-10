import { describe, expect, it, vi } from "vitest";

import { makeUsageMeteringClient } from "../src/usageMetering.js";

function makeMocks() {
  const getFn = vi.fn();
  const client = makeUsageMeteringClient(getFn as never);
  return { client, getFn };
}

const WIRE_RECORD = {
  id: "rec-1",
  org_id: "org-abc",
  action_type: "production.deploy",
  decision: "allow" as const,
  billable: true,
  recorded_at: "2026-06-01T10:00:00Z",
};

const WIRE_LIST_RESPONSE = {
  data: [WIRE_RECORD],
  next_cursor: "cursor-xyz",
};

const WIRE_SUMMARY = {
  org_id: "org-abc",
  period_start: "2026-06-01T00:00:00Z",
  period_end: "2026-06-30T23:59:59Z",
  total_evaluations: 1234,
  billable_allows: 1000,
  billable_denies: 200,
};

// ── list ──────────────────────────────────────────────────────────────────────

describe("usageMetering.list", () => {
  it("GETs /v1-usage-metering with no params", async () => {
    const { client, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: WIRE_LIST_RESPONSE });
    await client.list();
    expect(getFn.mock.calls[0]![0]).toBe("/v1-usage-metering");
    expect(getFn.mock.calls[0]![1]).toBeUndefined();
  });

  it("maps wire records to UsageMeteringRecord shape", async () => {
    const { client, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: WIRE_LIST_RESPONSE });
    const result = await client.list();
    expect(result.data).toHaveLength(1);
    const rec = result.data[0]!;
    expect(rec.id).toBe("rec-1");
    expect(rec.org_id).toBe("org-abc");
    expect(rec.action_type).toBe("production.deploy");
    expect(rec.decision).toBe("allow");
    expect(rec.billable).toBe(true);
    expect(rec.recorded_at).toBe("2026-06-01T10:00:00Z");
  });

  it("surfaces next_cursor when present", async () => {
    const { client, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: WIRE_LIST_RESPONSE });
    const result = await client.list();
    expect(result.next_cursor).toBe("cursor-xyz");
  });

  it("omits next_cursor when absent from wire", async () => {
    const { client, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: { data: [] } });
    const result = await client.list();
    expect(Object.keys(result)).not.toContain("next_cursor");
  });

  it("returns empty data array when absent from wire", async () => {
    const { client, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: { data: undefined } });
    const result = await client.list();
    expect(result.data).toEqual([]);
  });

  it("passes limit as query param", async () => {
    const { client, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: WIRE_LIST_RESPONSE });
    await client.list({ limit: 50 });
    const qs = getFn.mock.calls[0]![1] as URLSearchParams;
    expect(qs.get("limit")).toBe("50");
  });

  it("passes before as query param", async () => {
    const { client, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: WIRE_LIST_RESPONSE });
    await client.list({ before: "cursor-xyz" });
    const qs = getFn.mock.calls[0]![1] as URLSearchParams;
    expect(qs.get("before")).toBe("cursor-xyz");
  });

  it("passes decision filter as query param", async () => {
    const { client, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: WIRE_LIST_RESPONSE });
    await client.list({ decision: "deny" });
    const qs = getFn.mock.calls[0]![1] as URLSearchParams;
    expect(qs.get("decision")).toBe("deny");
  });

  it("passes multiple params simultaneously", async () => {
    const { client, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: WIRE_LIST_RESPONSE });
    await client.list({ limit: 25, decision: "allow", before: "abc" });
    const qs = getFn.mock.calls[0]![1] as URLSearchParams;
    expect(qs.get("limit")).toBe("25");
    expect(qs.get("decision")).toBe("allow");
    expect(qs.get("before")).toBe("abc");
  });

  it("omits query string when no params given", async () => {
    const { client, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: { data: [] } });
    await client.list({});
    expect(getFn.mock.calls[0]![1]).toBeUndefined();
  });

  it("handles deny decision records correctly", async () => {
    const { client, getFn } = makeMocks();
    const denyRecord = { ...WIRE_RECORD, decision: "deny" as const, billable: false };
    getFn.mockResolvedValue({ body: { data: [denyRecord] } });
    const result = await client.list();
    expect(result.data[0]!.decision).toBe("deny");
    expect(result.data[0]!.billable).toBe(false);
  });
});

// ── summary ───────────────────────────────────────────────────────────────────

describe("usageMetering.summary", () => {
  it("GETs /v1-usage-metering/summary with no params", async () => {
    const { client, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: WIRE_SUMMARY });
    await client.summary();
    expect(getFn.mock.calls[0]![0]).toBe("/v1-usage-metering/summary");
    expect(getFn.mock.calls[0]![1]).toBeUndefined();
  });

  it("maps wire summary to UsageMeteringSummary shape", async () => {
    const { client, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: WIRE_SUMMARY });
    const result = await client.summary();
    expect(result.org_id).toBe("org-abc");
    expect(result.period_start).toBe("2026-06-01T00:00:00Z");
    expect(result.period_end).toBe("2026-06-30T23:59:59Z");
    expect(result.total_evaluations).toBe(1234);
    expect(result.billable_allows).toBe(1000);
    expect(result.billable_denies).toBe(200);
  });

  it("passes period=day as query param", async () => {
    const { client, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: WIRE_SUMMARY });
    await client.summary({ period: "day" });
    const qs = getFn.mock.calls[0]![1] as URLSearchParams;
    expect(qs.get("period")).toBe("day");
  });

  it("passes period=week as query param", async () => {
    const { client, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: WIRE_SUMMARY });
    await client.summary({ period: "week" });
    const qs = getFn.mock.calls[0]![1] as URLSearchParams;
    expect(qs.get("period")).toBe("week");
  });

  it("passes period=month as query param", async () => {
    const { client, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: WIRE_SUMMARY });
    await client.summary({ period: "month" });
    const qs = getFn.mock.calls[0]![1] as URLSearchParams;
    expect(qs.get("period")).toBe("month");
  });

  it("omits query string when no period given", async () => {
    const { client, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: WIRE_SUMMARY });
    await client.summary({});
    expect(getFn.mock.calls[0]![1]).toBeUndefined();
  });
});
