/**
 * Policy-as-code GitOps sync types — wire shapes for `v1-policy-sync`.
 *
 * Supports a dry-run diff preview / apply workflow for pushing policy
 * bundles from CI/CD pipelines or the AtlaSent console.
 *
 * Typical flow:
 * 1. POST `{ policies, dry_run: true }` → receive `run` with `diff`
 * 2. Review diff, then POST `/{run.id}/apply` to execute
 *
 * Or POST `{ policies, dry_run: false }` for an immediate apply.
 */

export type PolicySyncStatus =
  | "pending"      // dry-run complete; awaiting apply
  | "validating"   // server is parsing the bundle
  | "applying"     // writes in progress
  | "completed"    // applied successfully
  | "failed"       // apply error; see server logs
  | "rejected";    // validation failed (e.g. schema error)

export interface PolicyRef {
  name: string;
  /** SHA-256 hex of the policy body. */
  body_hash?: string;
}

export interface PolicySyncDiff {
  added: PolicyRef[];
  updated: PolicyRef[];
  removed: PolicyRef[];
}

export interface PolicySyncRun {
  id: string;
  org_id: string;
  /** Identifies the caller: `"console"`, `"github-actions"`, etc. */
  source: string;
  commit_sha: string | null;
  ref: string | null;
  bundle_hash: string | null;
  status: PolicySyncStatus;
  policies_added: number;
  policies_updated: number;
  policies_removed: number;
  /** Populated on dry-run; null after apply. */
  diff: PolicySyncDiff | null;
  applied_by: string | null;
  created_at: string;
}

export interface PolicyBundleEntry {
  name: string;
  /** Policy body — OPA Rego, JSON schema, or custom DSL depending on config. */
  body: string;
  description?: string;
  tags?: string[];
}

export interface SubmitPolicySyncRequest {
  policies: PolicyBundleEntry[];
  /** Identifies the caller (e.g. `"github-actions"`, `"console"`). */
  source?: string;
  commit_sha?: string;
  ref?: string;
  /**
   * When `true` (default), computes the diff without applying changes.
   * The returned run will have `status: "pending"` and a populated `diff`.
   * POST to `/{run.id}/apply` to execute.
   */
  dry_run?: boolean;
}

export interface SubmitPolicySyncResponse {
  run: PolicySyncRun;
}

export interface ListPolicySyncRunsResponse {
  runs: PolicySyncRun[];
}

export interface ApplyPolicySyncResponse {
  run: PolicySyncRun;
}

/**
 * Returns a human-readable one-line diff summary suitable for CI logs.
 *
 * @example
 * formatPolicySyncDiff(run) // "+3 added, ~1 updated, -2 removed"
 * formatPolicySyncDiff(run) // "no changes"
 */
export function formatPolicySyncDiff(
  run: Pick<PolicySyncRun, "policies_added" | "policies_updated" | "policies_removed">,
): string {
  const parts: string[] = [];
  if (run.policies_added > 0) parts.push(`+${run.policies_added} added`);
  if (run.policies_updated > 0) parts.push(`~${run.policies_updated} updated`);
  if (run.policies_removed > 0) parts.push(`-${run.policies_removed} removed`);
  return parts.length > 0 ? parts.join(", ") : "no changes";
}

/**
 * Returns `true` when a sync run is in a terminal state
 * (completed, failed, or rejected) and no further transitions are expected.
 */
export function isPolicySyncTerminal(run: PolicySyncRun): boolean {
  return run.status === "completed" || run.status === "failed" || run.status === "rejected";
}
