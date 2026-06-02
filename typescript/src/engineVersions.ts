import type { RateLimitState } from "./types.js";

export type EngineVersionStatus = "active" | "retired" | "archival";

export interface EngineVersionRecord {
  engine_version: string;
  status: EngineVersionStatus;
  bundle_compatibility_range: string | null;
  supersedes_version: string | null;
  released_at: string;
  retired_at: string | null;
  archival_until: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface RegisterEngineVersionRequest {
  engine_version: string;
  status?: EngineVersionStatus;
  bundle_compatibility_range?: string;
  supersedes_version?: string;
  notes?: string;
  released_at?: string;
}

export interface EngineVersionResponse {
  engine_version: EngineVersionRecord;
  rateLimit: RateLimitState | null;
}

export interface ListEngineVersionsResponse {
  engine_versions: EngineVersionRecord[];
  rateLimit: RateLimitState | null;
}
