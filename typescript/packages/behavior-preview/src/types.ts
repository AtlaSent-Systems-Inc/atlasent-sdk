export type BehaviorCategory =
  | "behavior.health.mental"
  | "behavior.health.adherence"
  | "behavior.financial"
  | "behavior.minor";

export interface StateSummary {
  user_id: string;
  window_start: string;
  window_end: string;
  event_count: number;
  category_counts: Partial<Record<BehaviorCategory, number>>;
}

export interface BvsSnapshot {
  user_id: string;
  factors: Record<string, number>;
  confidence: number;
  confidence_low: boolean;
  computed_at: string;
}

export interface CategoryAggregate {
  user_id: string;
  category: BehaviorCategory;
  count: number;
  window_days: number;
  confidence_low: boolean;
}

export interface GetStateSummaryOptions {
  last_n?: number;
}

export interface GetCategoryAggregateOptions {
  window_days?: number;
}

export interface EvaluateRequestLike {
  context?: Record<string, unknown>;
  [k: string]: unknown;
}
