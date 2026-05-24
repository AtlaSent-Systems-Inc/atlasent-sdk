// @vitest-environment node
// BI4 — BvsSnapshot wire shape + attachToEvaluate context enrichment

import { describe, it, expect, vi, afterEach } from "vitest";
import { getBvsSnapshot } from "../packages/behavior/src/getBvsSnapshot.js";
import { attachToEvaluate } from "../packages/behavior/src/attachToEvaluate.js";
import type { BvsSnapshot, BehaviorClientOptions } from "../packages/behavior/src/types.js";

const OPTS: BehaviorClientOptions = {
  baseUrl: "http://behavior.internal",
  apiKey: "test-key",
};

const USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

const SAMPLE_SNAPSHOT: BvsSnapshot = {
  user_id: USER_ID,
  factors: { "regulation.relief": 0.7, "regulation.avoidance": 0.3 },
  confidence: 0.85,
  confidence_low: false,
  computed_at: "2026-05-24T00:00:00.000Z",
};

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// getBvsSnapshot
// ---------------------------------------------------------------------------

describe("getBvsSnapshot", () => {
  it("calls the correct endpoint and returns the snapshot", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify(SAMPLE_SNAPSHOT), { status: 200 }),
      ),
    );

    const result = await getBvsSnapshot(USER_ID, OPTS);
    expect(result).toEqual(SAMPLE_SNAPSHOT);

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe(
      `http://behavior.internal/api/patterns/snapshot/${USER_ID}`,
    );
  });

  it("encodes userId in the URL path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify(null), { status: 200 }),
      ),
    );

    await getBvsSnapshot("user with spaces", OPTS);
    const [url] = vi.mocked(fetch).mock.calls[0] as [string, ...unknown[]];
    expect(url).toContain("user%20with%20spaces");
  });

  it("returns null when the service returns null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify(null), { status: 200 }),
      ),
    );

    const result = await getBvsSnapshot(USER_ID, OPTS);
    expect(result).toBeNull();
  });

  it("throws when the service returns a non-2xx status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response("Forbidden", { status: 403 }),
      ),
    );

    await expect(getBvsSnapshot(USER_ID, OPTS)).rejects.toThrow(
      /behavior-insights 403/,
    );
  });

  it("sends Authorization header with the api key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify(null), { status: 200 }),
      ),
    );

    await getBvsSnapshot(USER_ID, OPTS);
    const [, init] = vi.mocked(fetch).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer test-key",
    );
  });
});

// ---------------------------------------------------------------------------
// attachToEvaluate
// ---------------------------------------------------------------------------

describe("attachToEvaluate", () => {
  it("returns { bvsSnapshot } when a snapshot is available", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify(SAMPLE_SNAPSHOT), { status: 200 }),
      ),
    );

    const ctx = await attachToEvaluate(USER_ID, OPTS);
    expect(ctx).toEqual({ bvsSnapshot: SAMPLE_SNAPSHOT });
  });

  it("returns {} when the snapshot is null (no data yet)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify(null), { status: 200 }),
      ),
    );

    const ctx = await attachToEvaluate(USER_ID, OPTS);
    expect(ctx).toEqual({});
  });

  it("returns {} and does NOT throw when the service is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED")),
    );

    const ctx = await attachToEvaluate(USER_ID, OPTS);
    expect(ctx).toEqual({});
  });

  it("returns {} and does NOT throw when the service returns 4xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(new Response("Forbidden", { status: 403 })),
    );

    const ctx = await attachToEvaluate(USER_ID, OPTS);
    expect(ctx).toEqual({});
  });

  it("the bvsSnapshot key matches the frozen BvsSnapshot wire shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify(SAMPLE_SNAPSHOT), { status: 200 }),
      ),
    );

    const ctx = await attachToEvaluate(USER_ID, OPTS);
    const snap = ctx["bvsSnapshot"] as BvsSnapshot;
    expect(typeof snap.user_id).toBe("string");
    expect(typeof snap.confidence).toBe("number");
    expect(typeof snap.confidence_low).toBe("boolean");
    expect(typeof snap.computed_at).toBe("string");
    expect(typeof snap.factors).toBe("object");
  });
});

// ---------------------------------------------------------------------------
// BvsSnapshot type shape (compile-time guard — assigning the constant above
// must satisfy the interface without a cast)
// ---------------------------------------------------------------------------

describe("BvsSnapshot wire shape", () => {
  it("is satisfied by the sample fixture (type guard)", () => {
    const snap: BvsSnapshot = SAMPLE_SNAPSHOT;
    expect(snap.user_id).toBe(USER_ID);
    expect(snap.confidence_low).toBe(false);
    expect(Object.keys(snap.factors).length).toBeGreaterThan(0);
  });
});
