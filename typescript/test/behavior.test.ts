import { describe, expect, it, beforeEach } from "vitest";
import {
  ConsentDeniedError,
  ConsentManager,
  DEFAULT_CONSENT,
  InMemoryBehaviorLedger,
  MemoryStorage,
  SENSITIVE_CATEGORIES,
  StateEventCache,
  redactStateSnapshot,
  type BehaviorEvent,
  type StateSnapshot,
} from "../src/behavior.js";

const SAMPLE_SNAPSHOT: StateSnapshot = {
  id: "snap_1",
  user_id: "u_1",
  emotional_state: "overwhelmed",
  intensity: 8,
  stress_level: 7,
  pressure_level: 6,
  body_state: "tight",
  cognitive_load: 9,
  readiness_level: "low",
  confidence_score: 0.8,
  created_at: "2026-04-26T12:00:00Z",
  note: "private free-form text that must never leak",
};

const SAMPLE_EVENT = (): BehaviorEvent => ({
  user_id: "u_1",
  source: "hicoach",
  category: "behavior.health.mental",
  entry_state_summary: redactStateSnapshot(SAMPLE_SNAPSHOT),
  exit_state_summary: null,
  relief_delta: null,
  confidence_score: 1,
  timestamp: "2026-04-26T12:00:00Z",
});

describe("redactStateSnapshot", () => {
  it("strips id, user_id, created_at, confidence_score, and note", () => {
    const summary = redactStateSnapshot(SAMPLE_SNAPSHOT);
    expect(summary).not.toHaveProperty("id");
    expect(summary).not.toHaveProperty("user_id");
    expect(summary).not.toHaveProperty("created_at");
    expect(summary).not.toHaveProperty("confidence_score");
    expect(summary).not.toHaveProperty("note");
  });

  it("preserves the bounded enum + numeric fields", () => {
    const summary = redactStateSnapshot(SAMPLE_SNAPSHOT);
    expect(summary).toEqual({
      emotional_state: "overwhelmed",
      intensity: 8,
      stress_level: 7,
      pressure_level: 6,
      body_state: "tight",
      cognitive_load: 9,
      readiness_level: "low",
    });
  });

  it("does not embed any string from `note`", () => {
    const summary = redactStateSnapshot(SAMPLE_SNAPSHOT);
    const json = JSON.stringify(summary);
    expect(json).not.toContain("private free-form text");
  });
});

describe("SENSITIVE_CATEGORIES", () => {
  it("exposes the four canonical slugs and only those", () => {
    expect(SENSITIVE_CATEGORIES).toEqual([
      "behavior.health.mental",
      "behavior.health.adherence",
      "behavior.financial",
      "behavior.minor",
    ]);
  });
});

describe("ConsentManager", () => {
  let storage: MemoryStorage;
  let consent: ConsentManager;

  beforeEach(() => {
    storage = new MemoryStorage();
    consent = new ConsentManager({ userId: "u_1", storage });
  });

  it("returns the privacy-first defaults on first read", () => {
    expect(consent.get()).toEqual(DEFAULT_CONSENT);
  });

  it("private_only_mode blocks emit even when share_state_summaries is true", () => {
    consent.set({ share_state_summaries: true, private_only_mode: true });
    expect(consent.canEmit("ledgers-me", "behavior.health.mental")).toBe(false);
  });

  it("share_state_summaries=false blocks emit regardless of receiver allowlist", () => {
    consent.set({
      share_state_summaries: false,
      receivers: { "ledgers-me": ["behavior.health.mental"] },
    });
    expect(consent.canEmit("ledgers-me", "behavior.health.mental")).toBe(false);
  });

  it("with share=true and no allowlist, allows emit to any receiver/category", () => {
    consent.set({ share_state_summaries: true });
    expect(consent.canEmit("ledgers-me", "behavior.health.mental")).toBe(true);
    expect(consent.canEmit("anyone", "behavior.financial")).toBe(true);
  });

  it("with share=true and an allowlist, denies non-listed (receiver, category) pairs", () => {
    consent.set({
      share_state_summaries: true,
      receivers: { "ledgers-me": ["behavior.health.mental"] },
    });
    expect(consent.canEmit("ledgers-me", "behavior.health.mental")).toBe(true);
    expect(consent.canEmit("ledgers-me", "behavior.financial")).toBe(false);
    expect(consent.canEmit("other", "behavior.health.mental")).toBe(false);
  });

  it("survives malformed JSON in storage by falling back to defaults", () => {
    storage.set("atlasent.behavior.consent.u_1", "{not-json");
    expect(consent.get()).toEqual(DEFAULT_CONSENT);
  });

  it("persists to storage via JSON", () => {
    consent.set({ share_state_summaries: true });
    const raw = storage.get("atlasent.behavior.consent.u_1");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toMatchObject({ share_state_summaries: true });
  });

  it("namespaces storage by userId so two users don't collide", () => {
    const c1 = new ConsentManager({ userId: "u_1", storage });
    const c2 = new ConsentManager({ userId: "u_2", storage });
    c1.set({ share_state_summaries: true });
    expect(c1.get().share_state_summaries).toBe(true);
    expect(c2.get().share_state_summaries).toBe(false);
  });
});

describe("InMemoryBehaviorLedger", () => {
  let consent: ConsentManager;
  let ledger: InMemoryBehaviorLedger;

  beforeEach(() => {
    consent = new ConsentManager({
      userId: "u_1",
      storage: new MemoryStorage(),
    });
    ledger = new InMemoryBehaviorLedger({
      consent,
      receiver: "ledgers-me",
    });
  });

  it("throws ConsentDeniedError when consent is missing", async () => {
    await expect(ledger.emit(SAMPLE_EVENT())).rejects.toBeInstanceOf(
      ConsentDeniedError,
    );
  });

  it("persists when consent allows", async () => {
    consent.set({ share_state_summaries: true });
    await ledger.emit(SAMPLE_EVENT());
    expect(ledger.list()).toHaveLength(1);
  });

  it("ConsentDeniedError carries the receiver and category", async () => {
    try {
      await ledger.emit(SAMPLE_EVENT());
      expect.fail("emit should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConsentDeniedError);
      const e = err as ConsentDeniedError;
      expect(e.receiver).toBe("ledgers-me");
      expect(e.category).toBe("behavior.health.mental");
      expect(e.code).toBe("consent_denied");
    }
  });

  it("respects the per-receiver allowlist on emit", async () => {
    consent.set({
      share_state_summaries: true,
      receivers: { "ledgers-me": ["behavior.financial"] },
    });
    // mental → denied (not in allowlist for ledgers-me)
    await expect(ledger.emit(SAMPLE_EVENT())).rejects.toBeInstanceOf(
      ConsentDeniedError,
    );
    // financial → allowed
    const allowed = { ...SAMPLE_EVENT(), category: "behavior.financial" as const };
    await expect(ledger.emit(allowed)).resolves.toBeUndefined();
  });

  it("clear() empties the buffer", async () => {
    consent.set({ share_state_summaries: true });
    await ledger.emit(SAMPLE_EVENT());
    ledger.clear();
    expect(ledger.list()).toHaveLength(0);
  });
});

describe("StateEventCache", () => {
  it("rejects capacity <= 0", () => {
    expect(() => new StateEventCache(0)).toThrow(RangeError);
    expect(() => new StateEventCache(-1)).toThrow(RangeError);
  });

  it("evicts oldest entries past capacity (FIFO ring buffer)", () => {
    const cache = new StateEventCache(2);
    const a = redactStateSnapshot({ ...SAMPLE_SNAPSHOT, intensity: 1 });
    const b = redactStateSnapshot({ ...SAMPLE_SNAPSHOT, intensity: 2 });
    const c = redactStateSnapshot({ ...SAMPLE_SNAPSHOT, intensity: 3 });
    cache.add(a);
    cache.add(b);
    cache.add(c);
    expect(cache.recent().map((s) => s.intensity)).toEqual([2, 3]);
  });

  it("recent(n) returns the last n entries in arrival order", () => {
    const cache = new StateEventCache(5);
    [1, 2, 3, 4, 5].forEach((intensity) =>
      cache.add(redactStateSnapshot({ ...SAMPLE_SNAPSHOT, intensity })),
    );
    expect(cache.recent(2).map((s) => s.intensity)).toEqual([4, 5]);
  });

  it("recent() with no argument returns everything", () => {
    const cache = new StateEventCache(5);
    cache.add(redactStateSnapshot(SAMPLE_SNAPSHOT));
    cache.add(redactStateSnapshot(SAMPLE_SNAPSHOT));
    expect(cache.recent()).toHaveLength(2);
  });

  it("clear() empties the buffer", () => {
    const cache = new StateEventCache(5);
    cache.add(redactStateSnapshot(SAMPLE_SNAPSHOT));
    cache.clear();
    expect(cache.recent()).toEqual([]);
  });
});
