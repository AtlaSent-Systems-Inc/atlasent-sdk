/**
 * @atlasent/sdk/behavior — consent + redaction helpers for the v2
 * Behavior Conditioning Layer.
 *
 * See `atlasent-docs/docs/V2_BEHAVIOR_CONDITIONING_LAYER.md` for the
 * architecture this module implements.
 *
 * Quick start:
 *
 * ```ts
 * import {
 *   ConsentManager,
 *   InMemoryBehaviorLedger,
 *   redactStateSnapshot,
 *   type StateSnapshot,
 * } from "@atlasent/sdk/behavior";
 *
 * const consent = new ConsentManager({ userId: "u_123" });
 * const ledger = new InMemoryBehaviorLedger();
 *
 * const snapshot: StateSnapshot = { ... };
 * const summary = redactStateSnapshot(snapshot);
 *
 * if (consent.canEmit("ledgers-me", "behavior.health.mental")) {
 *   await ledger.emit({
 *     user_id: snapshot.user_id,
 *     source: "hicoach",
 *     category: "behavior.health.mental",
 *     entry_state_summary: summary,
 *     exit_state_summary: null,
 *     relief_delta: null,
 *     confidence_score: 1,
 *     timestamp: new Date().toISOString(),
 *   });
 * }
 * ```
 *
 * The MVP is pure and on-device — no HTTP calls. A future
 * `RemoteBehaviorLedger` will POST to `/v1/behavior/events` once
 * the atlasent-api endpoint ships.
 */

// ---------------------------------------------------------------------------
// Sensitive-category vocabulary
// ---------------------------------------------------------------------------

/**
 * Sensitive-category slugs used by behavior policies. Keep in sync
 * with `gxp-starter/packs/hipaa/` rules and
 * `atlasent-api`'s `target.category` field.
 */
export type SensitiveCategory =
  | "behavior.health.mental"
  | "behavior.health.adherence"
  | "behavior.financial"
  | "behavior.minor";

export const SENSITIVE_CATEGORIES: readonly SensitiveCategory[] = [
  "behavior.health.mental",
  "behavior.health.adherence",
  "behavior.financial",
  "behavior.minor",
] as const;

// ---------------------------------------------------------------------------
// Domain types — mirror the model in `bettyc925/hicoach/lib/hicoach/types.ts`.
// ---------------------------------------------------------------------------

export type EmotionalState =
  | "tense"
  | "anxious"
  | "overwhelmed"
  | "flat"
  | "frustrated"
  | "uncertain"
  | "tired"
  | "okay";

export type BodyState =
  | "tight"
  | "heavy"
  | "restless"
  | "numb"
  | "buzzing"
  | "settled";

export type ReadinessLevel = "low" | "medium" | "high";

/**
 * A single moment captured before/after a regulation session.
 *
 * This is the **on-device** shape with all raw fields. It is never
 * emitted to a ledger; only the {@link StateEventSummary} projection
 * crosses an app boundary.
 */
export interface StateSnapshot {
  id: string;
  user_id: string;
  emotional_state: EmotionalState;
  /** 0..10 */
  intensity: number;
  /** 0..10 */
  stress_level: number;
  /** 0..10 */
  pressure_level: number;
  body_state: BodyState;
  /** 0..10 */
  cognitive_load: number;
  readiness_level: ReadinessLevel;
  /** 0..1 — how sure the user feels about the rating */
  confidence_score: number;
  /** ISO 8601 */
  created_at: string;
  /** Optional free-form note. NEVER part of the redacted summary. */
  note?: string;
}

/**
 * Redacted summary projection — the only shape that crosses an app
 * boundary. Contains no raw text, no IDs, no timestamps.
 */
export interface StateEventSummary {
  emotional_state: EmotionalState;
  intensity: number;
  stress_level: number;
  pressure_level: number;
  body_state: BodyState;
  cognitive_load: number;
  readiness_level: ReadinessLevel;
}

/**
 * A behavior event written to the cross-app ledger (LedgersMe).
 * The atlasent-api `/v1/behavior/events` endpoint accepts this shape.
 */
export interface BehaviorEvent {
  user_id: string;
  source: "hicoach" | "echobloom" | "ledgers-me" | string;
  category: SensitiveCategory;
  entry_state_summary: StateEventSummary;
  exit_state_summary: StateEventSummary | null;
  relief_delta: number | null;
  /** 0..1 */
  confidence_score: number;
  /** ISO 8601 */
  timestamp: string;
  /** Optional list of safety signals that fired during the event. Never raw text. */
  safety_signals?: string[];
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

/**
 * Per-user consent settings. Privacy-first defaults: nothing leaves
 * the device unless the user explicitly opts in.
 */
export interface ConsentSettings {
  /** Default false. Opt-in to emit summaries to the ledger. */
  share_state_summaries: boolean;
  /**
   * Default false. When true, suppresses ALL outbound emissions
   * regardless of any other setting. Acts as a global circuit
   * breaker.
   */
  private_only_mode: boolean;
  /**
   * Optional per-receiver allowlist. When non-empty, an event is
   * only emitted to a receiver whose name appears here AND for a
   * category whose slug appears in the receiver's allowed set.
   *
   * Example:
   * ```ts
   * { "ledgers-me": ["behavior.health.mental"] }
   * ```
   */
  receivers?: Record<string, SensitiveCategory[]>;
}

export const DEFAULT_CONSENT: ConsentSettings = Object.freeze({
  share_state_summaries: false,
  private_only_mode: false,
});

/**
 * Storage abstraction so the helper works in browser
 * (`window.localStorage`), Node, and tests.
 */
export interface ConsentStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/**
 * Default in-memory storage (for Node + tests). In a browser, pass
 * `window.localStorage`.
 */
export class MemoryStorage implements ConsentStorage {
  private store = new Map<string, string>();
  get(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  set(key: string, value: string): void {
    this.store.set(key, value);
  }
}

export interface ConsentManagerOpts {
  userId: string;
  /** Defaults to {@link MemoryStorage}. Pass `localStorage` in browsers. */
  storage?: ConsentStorage;
  /** Defaults to {@link DEFAULT_CONSENT}. */
  defaults?: ConsentSettings;
}

/**
 * Read/write consent settings; gate emissions through `canEmit`.
 *
 * Apps NEVER hand-roll consent checks. This is the only correct way
 * to decide whether a `BehaviorEvent` may leave the device.
 */
export class ConsentManager {
  private readonly key: string;
  private readonly storage: ConsentStorage;
  private readonly defaults: ConsentSettings;

  constructor(opts: ConsentManagerOpts) {
    this.key = `atlasent.behavior.consent.${opts.userId}`;
    this.storage = opts.storage ?? new MemoryStorage();
    this.defaults = opts.defaults ?? DEFAULT_CONSENT;
  }

  get(): ConsentSettings {
    const raw = this.storage.get(this.key);
    if (!raw) return { ...this.defaults };
    try {
      const parsed = JSON.parse(raw) as Partial<ConsentSettings>;
      return { ...this.defaults, ...parsed };
    } catch {
      return { ...this.defaults };
    }
  }

  set(patch: Partial<ConsentSettings>): ConsentSettings {
    const next = { ...this.get(), ...patch };
    this.storage.set(this.key, JSON.stringify(next));
    return next;
  }

  /**
   * The single decision point: may we emit a `BehaviorEvent` for
   * this `category` to this `receiver`? Returns `false` whenever
   * any of the following is true:
   *
   * - `private_only_mode` is on.
   * - `share_state_summaries` is off.
   * - A `receivers` allowlist exists and the `(receiver, category)`
   *   pair is not in it.
   */
  canEmit(receiver: string, category: SensitiveCategory): boolean {
    const c = this.get();
    if (c.private_only_mode) return false;
    if (!c.share_state_summaries) return false;
    if (c.receivers) {
      const allowed = c.receivers[receiver] ?? [];
      if (!allowed.includes(category)) return false;
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Project a {@link StateSnapshot} down to the redacted
 * {@link StateEventSummary} shape. Drops `id`, `user_id`,
 * `created_at`, `confidence_score`, and any `note` field. The
 * remaining fields are bounded numeric ranges or closed enums and
 * carry no free-form text.
 */
export function redactStateSnapshot(s: StateSnapshot): StateEventSummary {
  return {
    emotional_state: s.emotional_state,
    intensity: s.intensity,
    stress_level: s.stress_level,
    pressure_level: s.pressure_level,
    body_state: s.body_state,
    cognitive_load: s.cognitive_load,
    readiness_level: s.readiness_level,
  };
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export interface BehaviorLedger {
  /**
   * Emit a behavior event. Implementations MUST validate `consent`
   * before persisting and throw `ConsentDeniedError` when an event
   * would be persisted in violation of the user's settings.
   */
  emit(event: BehaviorEvent): Promise<void>;
}

export class ConsentDeniedError extends Error {
  readonly code = "consent_denied" as const;
  constructor(
    public readonly receiver: string,
    public readonly category: SensitiveCategory,
  ) {
    super(
      `Consent denies emit to receiver=${receiver} category=${category}`,
    );
    this.name = "ConsentDeniedError";
  }
}

/**
 * On-device ledger for development and demos. A future
 * `RemoteBehaviorLedger` will POST to atlasent-api's
 * `/v1/behavior/events` once that endpoint ships.
 */
export class InMemoryBehaviorLedger implements BehaviorLedger {
  private readonly events: BehaviorEvent[] = [];
  constructor(
    private readonly opts: {
      consent: ConsentManager;
      receiver?: string;
    },
  ) {}

  async emit(event: BehaviorEvent): Promise<void> {
    const receiver = this.opts.receiver ?? "in-memory";
    if (!this.opts.consent.canEmit(receiver, event.category)) {
      throw new ConsentDeniedError(receiver, event.category);
    }
    this.events.push(event);
  }

  /** Read all events accepted so far. Test/demo helper. */
  list(): readonly BehaviorEvent[] {
    return [...this.events];
  }

  /** Clear the in-memory store. Test helper. */
  clear(): void {
    this.events.length = 0;
  }
}

// ---------------------------------------------------------------------------
// State-event cache (for biasing AI suggestions with recent context)
// ---------------------------------------------------------------------------

/**
 * Bounded in-memory ring buffer of recent {@link StateEventSummary}
 * values. The LangChain/LlamaIndex middleware (and similar wrappers)
 * read this to attach `context.session_history` to evaluate calls
 * without ever touching raw snapshots.
 */
export class StateEventCache {
  private readonly buf: StateEventSummary[] = [];
  constructor(private readonly capacity: number = 10) {
    if (capacity <= 0) {
      throw new RangeError("capacity must be > 0");
    }
  }

  add(summary: StateEventSummary): void {
    this.buf.push(summary);
    if (this.buf.length > this.capacity) this.buf.shift();
  }

  recent(n?: number): readonly StateEventSummary[] {
    const k = n ?? this.buf.length;
    return this.buf.slice(-k);
  }

  clear(): void {
    this.buf.length = 0;
  }
}
