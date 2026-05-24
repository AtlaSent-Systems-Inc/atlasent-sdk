// @vitest-environment node
// BI5 — ConsentClassProjection type and assertNoRawText privacy guard

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  assertNoRawText,
  RawTextLeakError,
} from "../packages/behavior/src/privacy.js";
import { getStateSummary } from "../packages/behavior/src/getStateSummary.js";
import type {
  ConsentClassProjection,
  StateSummary,
  BehaviorClientOptions,
} from "../packages/behavior/src/types.js";

const OPTS: BehaviorClientOptions = {
  baseUrl: "http://behavior.internal",
  apiKey: "test-key",
};

const USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

const SAFE_SUMMARY: StateSummary = {
  user_id: USER_ID,
  window_start: "2026-04-24T00:00:00.000Z",
  window_end: "2026-05-24T00:00:00.000Z",
  event_count: 12,
  category_counts: {
    "behavior.financial": 5,
    "behavior.health.mental": 7,
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// assertNoRawText
// ---------------------------------------------------------------------------

describe("assertNoRawText", () => {
  it("passes for a clean aggregate-only object", () => {
    expect(() => assertNoRawText(SAFE_SUMMARY)).not.toThrow();
  });

  it("throws RawTextLeakError when 'text' field is present", () => {
    expect(() =>
      assertNoRawText({ ...SAFE_SUMMARY, text: "some raw text" }),
    ).toThrow(RawTextLeakError);
  });

  it("throws RawTextLeakError when 'note' field is present", () => {
    expect(() =>
      assertNoRawText({ ...SAFE_SUMMARY, note: "private note" }),
    ).toThrow(RawTextLeakError);
  });

  it("throws RawTextLeakError when 'cue' field is present", () => {
    expect(() => assertNoRawText({ cue: "trigger text" })).toThrow(
      RawTextLeakError,
    );
  });

  it("throws RawTextLeakError when 'interpretation' field is present", () => {
    expect(() =>
      assertNoRawText({ interpretation: "therapist note" }),
    ).toThrow(RawTextLeakError);
  });

  it("throws for nested raw text fields", () => {
    expect(() =>
      assertNoRawText({ metadata: { note: "nested raw" } }),
    ).toThrow(RawTextLeakError);
  });

  it("includes the field name in the error message", () => {
    let err: unknown;
    try {
      assertNoRawText({ text: "oops" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RawTextLeakError);
    const e = err as RawTextLeakError;
    expect(e.field).toBe("text");
    expect(e.message).toMatch(/raw text field "text"/);
  });

  it("includes the path in the error message for nested violations", () => {
    let err: unknown;
    try {
      assertNoRawText({ outer: { note: "bad" } }, "StateSummary");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RawTextLeakError);
    expect((err as RawTextLeakError).path).toBe("StateSummary.outer.note");
  });

  it("passes for null input (no-op)", () => {
    expect(() => assertNoRawText(null)).not.toThrow();
  });

  it("passes for primitive input (no-op)", () => {
    expect(() => assertNoRawText("string")).not.toThrow();
    expect(() => assertNoRawText(42)).not.toThrow();
  });

  it("passes when blocked keys appear as values not keys", () => {
    // The value "note" is fine; it's only the key "note" that's blocked
    expect(() => assertNoRawText({ label: "note" })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// getStateSummary privacy guard (BI5 server + client enforcement)
// ---------------------------------------------------------------------------

describe("getStateSummary privacy guard", () => {
  it("returns a clean StateSummary without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify(SAFE_SUMMARY), { status: 200 }),
      ),
    );

    const result = await getStateSummary(USER_ID, OPTS);
    expect(result).toEqual(SAFE_SUMMARY);
  });

  it("throws RawTextLeakError if behavior-insights returns a raw text field", async () => {
    const poisoned = { ...SAFE_SUMMARY, note: "this should never happen" };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify(poisoned), { status: 200 }),
      ),
    );

    await expect(getStateSummary(USER_ID, OPTS)).rejects.toThrow(
      RawTextLeakError,
    );
  });

  it("returns null without asserting when the service returns null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify(null), { status: 200 }),
      ),
    );

    const result = await getStateSummary(USER_ID, OPTS);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ConsentClassProjection type guard (compile-time — assigning StateSummary
// to ConsentClassProjection must compile without a cast)
// ---------------------------------------------------------------------------

describe("ConsentClassProjection type compatibility", () => {
  it("StateSummary satisfies ConsentClassProjection (structural alias)", () => {
    const projection: ConsentClassProjection = SAFE_SUMMARY;
    expect(projection.user_id).toBe(USER_ID);
    expect(projection.event_count).toBe(12);
    expect(Object.keys(projection.category_counts)).toHaveLength(2);
  });

  it("cross-user redacted response (event_count=0) satisfies ConsentClassProjection", () => {
    const redacted: ConsentClassProjection = {
      user_id: USER_ID,
      window_start: "2026-04-24T00:00:00.000Z",
      window_end: "2026-05-24T00:00:00.000Z",
      event_count: 0,
      category_counts: {},
    };
    expect(redacted.event_count).toBe(0);
    expect(Object.keys(redacted.category_counts)).toHaveLength(0);
  });
});
