export type BvsSource =
  | "hiCoach"
  | "Echobloom"
  | "CalmState"
  | "LedgersMe"
  | "FutureBloomPlanner";

export type BvsFactorKey =
  | "pressure"
  | "social_risk"
  | "authority"
  | "time_pressure"
  | "environment"
  | "culture"
  | "money"
  | "fatigue"
  | "prior_failure"
  | "ambiguity"
  | "conflict";

export type BvsFactorIntensity = "low" | "medium" | "high";

export interface BvsContextFactor {
  factor: BvsFactorKey;
  intensity: BvsFactorIntensity;
}

export interface BvsEpisodeEvent {
  kind: "episode";
  subject_id: string;
  episode_id: string;
  captured_at: string;
  context_factors: BvsContextFactor[];
  energy_level: string;
  emotional_tone: string;
  body_state?: string;
}

export interface BvsPracticeEvent {
  kind: "practice";
  subject_id: string;
  episode_id: string;
  captured_at: string;
  practice_id: string;
  status_from: string | null;
  status_to: string;
  duration_setting: string;
}

export interface BvsIntentionEvent {
  kind: "intention";
  subject_id: string;
  episode_id: string;
  captured_at: string;
  practice_id: string;
  /** Whether the user set an intention. Never include intention text. */
  has_intention: boolean;
  date: string;
}

export interface BvsReflectionEvent {
  kind: "reflection";
  subject_id: string;
  episode_id: string;
  captured_at: string;
  practice_id: string;
  intention_id: string | null;
  /** Whether the user submitted a reflection. Never include reflection text. */
  has_reflection: boolean;
}

export type BvsEvent =
  | BvsEpisodeEvent
  | BvsPracticeEvent
  | BvsIntentionEvent
  | BvsReflectionEvent;

export interface BehaviorEmitOptions {
  /** behavior-insights ingest base URL */
  endpoint: string;
  /** HMAC-SHA256 signing secret shared with the behavior-insights server */
  hmacSecret: string;
  /** Optional Bearer token for /api/internal/* auth */
  serviceToken?: string;
  /** Request timeout ms. Default: 10_000 */
  timeoutMs?: number;
}

export interface EmitResult {
  ok: boolean;
  status: number;
}
