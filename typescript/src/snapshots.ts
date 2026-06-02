import type { RateLimitState } from "./types.js";

export type SnapshotSourceKind =
  | "system_state"
  | "external_system"
  | "caller_provided";

export interface StateSnapshotInput {
  source: string;
  source_kind: SnapshotSourceKind;
  complete: boolean;
  payload: Record<string, unknown>;
}

export interface StateSnapshotRef {
  snapshot_id: string;
  canonical_hash?: string;
}

export interface StateSnapshot extends StateSnapshotRef {
  organization_id: string;
  source: string;
  source_kind: SnapshotSourceKind;
  complete: boolean;
  tamper_detected: boolean;
  created_at: string;
}
