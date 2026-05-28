import { describe, expect, it, vi } from "vitest";

import { makeEvidenceBundleClient } from "../src/evidence-bundle.js";

function makeMocks() {
  const postFn   = vi.fn();
  const getFn    = vi.fn();
  const getRawFn = vi.fn();
  const eb = makeEvidenceBundleClient(
    postFn as never,
    getFn as never,
    getRawFn as never,
  );
  return { eb, postFn, getFn, getRawFn };
}

const WIRE_BUNDLE = {
  bundle_id: "bnd_abc",
  org_id: "org_xyz",
  incident_id: "inc_123",
  status: "pending" as const,
  included_permits: ["pt_1"],
  include_overrides: false,
  format: "json" as const,
  created_at: "2026-01-01T00:00:00Z",
  expires_at: "2026-01-08T00:00:00Z",
};

describe("evidenceBundles.create", () => {
  it("POSTs to /v1/evidence-bundles and maps wire fields to camelCase", async () => {
    const { eb, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: WIRE_BUNDLE });
    const result = await eb.create({ incidentId: "inc_123" });
    expect(postFn).toHaveBeenCalledWith("/v1/evidence-bundles", { incident_id: "inc_123" });
    expect(result.bundleId).toBe("bnd_abc");
    expect(result.orgId).toBe("org_xyz");
    expect(result.incidentId).toBe("inc_123");
    expect(result.status).toBe("pending");
  });

  it("includes includedPermits and includeOverrides when provided", async () => {
    const { eb, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: { ...WIRE_BUNDLE, include_overrides: true } });
    await eb.create({ incidentId: "inc_123", includedPermits: ["pt_1", "pt_2"], includeOverrides: true });
    const body = postFn.mock.calls[0]![1] as Record<string, unknown>;
    expect(body["included_permits"]).toEqual(["pt_1", "pt_2"]);
    expect(body["include_overrides"]).toBe(true);
  });

  it("omits optional fields when not provided", async () => {
    const { eb, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: WIRE_BUNDLE });
    await eb.create({ incidentId: "inc_123" });
    const body = postFn.mock.calls[0]![1] as Record<string, unknown>;
    expect(body).not.toHaveProperty("included_permits");
    expect(body).not.toHaveProperty("include_overrides");
  });

  it("surfaces optional downloadUrl when present", async () => {
    const { eb, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: { ...WIRE_BUNDLE, download_url: "https://example.com/dl" } });
    const result = await eb.create({ incidentId: "inc_123" });
    expect(result.downloadUrl).toBe("https://example.com/dl");
  });
});

describe("evidenceBundles.get", () => {
  it("GETs /v1/evidence-bundles/{id} and maps response", async () => {
    const { eb, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: WIRE_BUNDLE });
    const result = await eb.get("bnd_abc");
    expect(getFn).toHaveBeenCalledWith("/v1/evidence-bundles/bnd_abc");
    expect(result.bundleId).toBe("bnd_abc");
  });

  it("URL-encodes bundleId", async () => {
    const { eb, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: WIRE_BUNDLE });
    await eb.get("bnd/special");
    expect(getFn.mock.calls[0]![0] as string).toContain("bnd%2Fspecial");
  });
});

describe("evidenceBundles.list", () => {
  const WIRE_LIST = { bundles: [WIRE_BUNDLE], next_cursor: "cur_abc" };

  it("GETs /v1/evidence-bundles with no query params when called with no args", async () => {
    const { eb, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: { bundles: [], next_cursor: null } });
    const page = await eb.list();
    expect(getFn).toHaveBeenCalledWith("/v1/evidence-bundles", undefined);
    expect(page.bundles).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it("passes limit, cursor, and executionId as query params", async () => {
    const { eb, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: WIRE_LIST });
    await eb.list({ limit: 10, cursor: "cur_prev", executionId: "exec_1" });
    const qs = getFn.mock.calls[0]![1] as URLSearchParams;
    expect(qs.get("limit")).toBe("10");
    expect(qs.get("cursor")).toBe("cur_prev");
    expect(qs.get("execution_id")).toBe("exec_1");
  });

  it("maps wire bundles to camelCase and returns nextCursor", async () => {
    const { eb, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: WIRE_LIST });
    const page = await eb.list({ limit: 1 });
    expect(page.bundles).toHaveLength(1);
    expect(page.bundles[0]!.bundleId).toBe("bnd_abc");
    expect(page.nextCursor).toBe("cur_abc");
  });

  it("returns nextCursor null when not present", async () => {
    const { eb, getFn } = makeMocks();
    getFn.mockResolvedValue({ body: { bundles: [WIRE_BUNDLE] } });
    const page = await eb.list();
    expect(page.nextCursor).toBeNull();
  });
});

describe("evidenceBundles.download", () => {
  it("calls getRaw with json format by default", async () => {
    const { eb, getRawFn } = makeMocks();
    getRawFn.mockResolvedValue(new ArrayBuffer(4));
    const buf = await eb.download("bnd_abc");
    expect(getRawFn.mock.calls[0]![0] as string).toContain("format=json");
    expect(Buffer.isBuffer(buf)).toBe(true);
  });

  it("passes pdf format when requested", async () => {
    const { eb, getRawFn } = makeMocks();
    getRawFn.mockResolvedValue(new ArrayBuffer(4));
    await eb.download("bnd_abc", "pdf");
    expect(getRawFn.mock.calls[0]![0] as string).toContain("format=pdf");
  });

  it("returns Buffer wrapping the ArrayBuffer bytes", async () => {
    const { eb, getRawFn } = makeMocks();
    const data = new Uint8Array([1, 2, 3, 4]);
    getRawFn.mockResolvedValue(data.buffer);
    const buf = await eb.download("bnd_abc");
    expect(buf[0]).toBe(1);
    expect(buf[3]).toBe(4);
  });
});
