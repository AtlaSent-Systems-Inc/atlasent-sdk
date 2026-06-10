import type { RateLimitState } from "./types.js";

export type DependencyRequirement = "permit" | "allow_decision";
export type DependencyStatus = "satisfied" | "missing" | "expired" | "invalid";

export interface ActionDependency {
  id: string;
  org_id: string;
  parent_action_class_id: string;
  child_action_class_id: string;
  requires: DependencyRequirement;
  temporal_window_seconds: number | null;
  created_at: string;
}

export interface CreateActionDependencyRequest {
  parent_action_class_id: string;
  child_action_class_id: string;
  requires?: DependencyRequirement;
  temporal_window_seconds?: number;
}

export interface ActionDependencyResponse {
  action_dependency: ActionDependency;
  rateLimit: RateLimitState | null;
}

export interface ListActionDependenciesResponse {
  action_dependencies: ActionDependency[];
  total: number;
  limit: number;
  offset: number;
  rateLimit: RateLimitState | null;
}

export interface DependencyLink {
  dependency_id: string;
  parent_evaluation_id?: string;
  parent_permit_token_hash?: string;
  status: DependencyStatus;
}
