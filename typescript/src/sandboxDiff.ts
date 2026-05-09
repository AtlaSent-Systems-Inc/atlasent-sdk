/**
 * Sandbox simulation diff — wire shape for `GET /v1/agent-sandbox/:id/diff`.
 *
 * Mirrors the `export_sandbox_diff()` SQL function added in migration
 * 20260509120000. Lets a caller render a sandbox-vs-live preview
 * before promoting a simulation to a real execution. Once a sandbox
 * run reaches a terminal status it is auto-torn-down; a follow-up
 * call returns the {@link SandboxDiffEmpty} shape so the UI can
 * surface "this run has been finalised" without a 404.
 */

export type SandboxRunMode =
  | "dry_run"
  | "simulation"
  | "constrained_execution"
  | "production_execution";

export type SandboxRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export type SandboxWriteOp = "insert" | "update" | "delete";

export interface SandboxRunWrite {
  sequence: number;
  live_table: string;
  live_pk: string | null;
  op: SandboxWriteOp;
  payload_before: Record<string, unknown> | null;
  payload_after: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface SandboxDiffPerTable {
  total: number;
  insert: number;
  update: number;
  delete: number;
}

/** Returned when staging rows are still present for the run. */
export interface SandboxDiff {
  simulation_run_id: string;
  org_id: string;
  final_status: SandboxRunStatus;
  mode: SandboxRunMode;
  total_writes: number;
  /** Keyed by live table name. */
  summary: Record<string, SandboxDiffPerTable>;
  writes: SandboxRunWrite[];
}

/**
 * Returned when the run has been torn down — staging rows are gone
 * and the audit-log `agent_sandbox.teardown` event is the only
 * post-mortem record.
 */
export interface SandboxDiffEmpty {
  simulation_run_id: string;
  status: SandboxRunStatus;
  mode: SandboxRunMode;
  torn_down: boolean;
  total_writes: 0;
  summary: Record<string, never>;
  writes: [];
}

export type SandboxDiffResponse = SandboxDiff | SandboxDiffEmpty;

/**
 * `true` when the response carries staging rows (i.e. the run has not
 * been torn down yet). Narrow before reading `summary` / `writes`.
 */
export function isSandboxDiffPopulated(
  r: SandboxDiffResponse,
): r is SandboxDiff {
  return r.total_writes > 0 || (r as SandboxDiff).org_id !== undefined;
}
