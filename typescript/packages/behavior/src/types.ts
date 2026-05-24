export type BehaviorCategory =
  | "behavior.health.mental"
  | "behavior.health.adherence"
  | "behavior.financial"
  | "behavior.minor";

export interface BvsSnapshot {
  user_id: string;
  factors: Record<string, number>;
  confidence: number;
  confidence_low: boolean;
  computed_at: string;
}

export interface StateSummary {
  user_id: string;
  window_start: string;
  window_end: string;
  event_count: number;
  category_counts: Partial<Record<BehaviorCategory, number>>;
}

export interface CategoryAggregate {
  user_id: string;
  category: BehaviorCategory;
  count: number;
  window_days: number;
  confidence_low: boolean;
}

export interface BehaviorClientOptions {
  baseUrl: string;       // behavior-insights service URL
  apiKey: string;        // service API key
  timeoutMs?: number;    // default 10000
}

export interface GetStateSummaryOptions {
  windowDays?: number;   // default 30
}

export interface GetCategoryAggregateOptions {
  windowDays?: number;   // default 30
}

/**
 * Consent-class projection (BI5) — the privacy-safe shape that crosses the
 * LedgersMe (and other third-party app) boundary. Identical in structure to
 * {@link StateSummary} but explicitly named so callers understand this is the
 * redacted, aggregate-only surface: counts and timestamps only, never raw
 * free-text or per-event payloads. The behavior-insights server enforces this
 * server-side (cross-user callers receive event_count=0 + empty
 * category_counts); the SDK enforces it client-side via assertNoRawText.
 */
export type ConsentClassProjection = StateSummary;
