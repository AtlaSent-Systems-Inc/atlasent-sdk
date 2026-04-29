/**
 * Tests for `evaluateBatchPolyfilled`.
 *
 * Strategy: hand-rolled fake `BatchPolyfillClient` whose `evaluate()`
 * returns pre-canned responses (allow / deny / mixed) and tracks
 * call order + concurrency. No `vi.mock` needed — the polyfill is
 * structurally typed against the client interface.
 */

import { describe, expect, it } from "vitest";

import { evaluateBatchPolyfilled } from "../src/evaluateBatchPolyfill.js";
import type {
  BatchEvaluateItem,
  BatchPolyfillClient,
} from "../src/index.js";

interface FakeEvaluateResponse {
  decision: "ALLOW" | "DENY";
  permitId: string;
  reason: string;
  auditHash: string;
  timestamp: string;
}

function fakeClient(
  responder: (
    input: { agent: string; action: string; context?: unknown },
    callIndex: number,
  ) => FakeEvaluateResponse | Promise<FakeEvaluateResponse>,
): BatchPolyfillClient & { calls: number; inFlight: number; maxInFlight: number } {
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const client = {
    async evaluate(input: { agent: string; action: string; context?: unknown }) {
      const idx = calls;
      calls += 1;
      inFlight += 1;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      try {
        const result = await responder(input, idx);
        return result;
      } finally {
        inFlight -= 1;
      }
    },
    get calls() {
      return calls;
    },
    get inFlight() {
      return inFlight;
    },
    get maxInFlight() {
      return maxInFlight;
    },
  };
  return client as BatchPolyfillClient & {
    calls: number;
    inFlight: number;
    maxInFlight: number;
  };
}

const ITEM: BatchEvaluateItem = {
  action: "modify_record",
  agent: "agent-1",
  context: { id: "PT-001" },
};

// ── Happy path ──────────────────────────────────────────────────────


describe("evaluateBatchPolyfilled — happy path", () => {
  it("returns the v2 EvaluateBatchResponse shape", async () => {
    const client = fakeClient(() => ({
      decision: "ALLOW",
      permitId: "dec_alpha",
      reason: "ok",
      auditHash: "a".repeat(64),
      timestamp: "2026-04-25T00:00:00Z",
    }));
    const result = await evaluateBatchPolyfilled(client, [ITEM], {
      batchId: "fixed-batch-id",
    });
    expect(result.batch_id).toBe("fixed-batch-id");
    expect(result.items).toHaveLength(1);
    const item = result.items[0]!;
    expect(item.permitted).toBe(true);
    expect(item.index).toBe(0);
    expect(item.decision_id).toBe("dec_alpha");
    expect(item.reason).toBe("ok");
    expect(item.audit_hash).toBe("a".repeat(64));
    expect(item.batch_id).toBe("fixed-batch-id");
  });

  it("preserves input order across mixed allow/deny", async () => {
    const items: BatchEvaluateItem[] = [
      { ...ITEM, context: { id: "0" } },
      { ...ITEM, context: { id: "1" } },
      { ...ITEM, context: { id: "2" } },
    ];
    const client = fakeClient((input) => {
      const id = (input.context as { id: string }).id;
      return {
        decision: id === "1" ? "DENY" : "ALLOW",
        permitId: `dec_${id}`,
        reason: id === "1" ? "missing change_reason" : "ok",
        auditHash: id.repeat(64),
        timestamp: "t",
      };
    });

    const result = await evaluateBatchPolyfilled(client, items, {
      batchId: "b",
    });

    expect(result.items.map((i) => i.permitted)).toEqual([true, false, true]);
    expect(result.items.map((i) => i.index)).toEqual([0, 1, 2]);
    expect(result.items.map((i) => i.decision_id)).toEqual([
      "dec_0",
      "dec_1",
      "dec_2",
    ]);
  });

  it("generates a fresh UUID batch_id when not provided", async () => {
    const client = fakeClient(() => ({
      decision: "ALLOW",
      permitId: "p",
      reason: "",
      auditHash: "",
      timestamp: "t",
    }));
    const a = await evaluateBatchPolyfilled(client, [ITEM]);
    const b = await evaluateBatchPolyfilled(client, [ITEM]);
    expect(a.batch_id).not.toBe(b.batch_id);
    // UUID v4: 36 chars, lowercase hex with dashes.
    expect(a.batch_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

// ── Concurrency cap ─────────────────────────────────────────────────


describe("evaluateBatchPolyfilled — concurrency cap", () => {
  it("defaults to 10 in-flight at most", async () => {
    const items = Array.from({ length: 50 }, (_, i): BatchEvaluateItem => ({
      ...ITEM,
      context: { id: String(i) },
    }));
    const client = fakeClient(async () => {
      // Yield a tick so multiple evaluates overlap.
      await new Promise((r) => setTimeout(r, 1));
      return {
        decision: "ALLOW",
        permitId: "p",
        reason: "",
        auditHash: "",
        timestamp: "t",
      };
    });

    await evaluateBatchPolyfilled(client, items);

    expect(client.calls).toBe(50);
    expect(client.maxInFlight).toBeLessThanOrEqual(10);
  });

  it("respects a custom concurrency setting", async () => {
    const items = Array.from({ length: 20 }, (): BatchEvaluateItem => ITEM);
    const client = fakeClient(async () => {
      await new Promise((r) => setTimeout(r, 1));
      return {
        decision: "ALLOW",
        permitId: "p",
        reason: "",
        auditHash: "",
        timestamp: "t",
      };
    });

    await evaluateBatchPolyfilled(client, items, { concurrency: 3 });

    expect(client.maxInFlight).toBeLessThanOrEqual(3);
  });

  it("uses the fast path (Promise.all) when concurrency >= item count", async () => {
    const items = Array.from({ length: 5 }, (): BatchEvaluateItem => ITEM);
    const client = fakeClient(async () => {
      await new Promise((r) => setTimeout(r, 1));
      return {
        decision: "ALLOW",
        permitId: "p",
        reason: "",
        auditHash: "",
        timestamp: "t",
      };
    });

    await evaluateBatchPolyfilled(client, items, { concurrency: 100 });

    expect(client.calls).toBe(5);
    expect(client.maxInFlight).toBe(5);
  });

  it("rejects concurrency < 1", async () => {
    const client = fakeClient(() => ({
      decision: "ALLOW",
      permitId: "p",
      reason: "",
      auditHash: "",
      timestamp: "t",
    }));
    await expect(
      evaluateBatchPolyfilled(client, [ITEM], { concurrency: 0 }),
    ).rejects.toThrow(/concurrency/i);
  });
});

// ── Validation reuse ────────────────────────────────────────────────


describe("evaluateBatchPolyfilled — validation", () => {
  it("validates via buildEvaluateBatchRequest (rejects empty items)", async () => {
    const client = fakeClient(() => ({
      decision: "ALLOW",
      permitId: "p",
      reason: "",
      auditHash: "",
      timestamp: "t",
    }));
    await expect(
      evaluateBatchPolyfilled(client, []),
    ).rejects.toThrow(/at least 1 item/i);
  });

  it("rejects > 1000 items", async () => {
    const client = fakeClient(() => ({
      decision: "ALLOW",
      permitId: "p",
      reason: "",
      auditHash: "",
      timestamp: "t",
    }));
    const items = Array.from({ length: 1001 }, (): BatchEvaluateItem => ITEM);
    await expect(evaluateBatchPolyfilled(client, items)).rejects.toThrow(
      /exceeds max 1000/i,
    );
  });

  it("rejects items with empty action", async () => {
    const client = fakeClient(() => ({
      decision: "ALLOW",
      permitId: "p",
      reason: "",
      auditHash: "",
      timestamp: "t",
    }));
    await expect(
      evaluateBatchPolyfilled(client, [{ ...ITEM, action: "" }]),
    ).rejects.toThrow(/items\[0\]\.action/i);
  });
});

// ── Error propagation ──────────────────────────────────────────────


describe("evaluateBatchPolyfilled — error propagation", () => {
  it("propagates a transport failure from any underlying evaluate()", async () => {
    const items = Array.from({ length: 5 }, (): BatchEvaluateItem => ITEM);
    const client = fakeClient((_, idx) => {
      if (idx === 2) {
        throw new Error("network error");
      }
      return {
        decision: "ALLOW",
        permitId: "p",
        reason: "",
        auditHash: "",
        timestamp: "t",
      };
    });

    await expect(evaluateBatchPolyfilled(client, items)).rejects.toThrow(
      "network error",
    );
  });

  it("clean denials (decision=DENY) become permitted: false, NOT throws", async () => {
    const client = fakeClient(() => ({
      decision: "DENY",
      permitId: "dec_x",
      reason: "policy denied",
      auditHash: "h",
      timestamp: "t",
    }));
    const result = await evaluateBatchPolyfilled(client, [ITEM]);
    expect(result.items[0]?.permitted).toBe(false);
    expect(result.items[0]?.reason).toBe("policy denied");
  });
});

// ── Boundary: exactly 1000 items ────────────────────────────────────


describe("evaluateBatchPolyfilled — 1000-item boundary", () => {
  it("accepts exactly 1000 items", async () => {
    const items = Array.from({ length: 1000 }, (): BatchEvaluateItem => ITEM);
    const client = fakeClient(() => ({
      decision: "ALLOW",
      permitId: "p",
      reason: "",
      auditHash: "",
      timestamp: "t",
    }));
    const result = await evaluateBatchPolyfilled(client, items, {
      concurrency: 50,
    });
    expect(result.items).toHaveLength(1000);
  });
});
