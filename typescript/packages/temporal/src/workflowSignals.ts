/**
 * Workflow-side signal helpers for the Temporal adapter.
 *
 * Pillar 8 piece called out in PR #57's V2 plan:
 *
 * > **Revocation signal**: Workflow signal `revokeAtlaSentPermits()`
 * > calls the server-side bulk revoke keyed on the workflow run id.
 *
 * This file lives in the same package as `withAtlaSentActivity`
 * (the activity-side helper) but imports `@temporalio/workflow`
 * — Temporal forbids workflow code from importing activity-side
 * APIs and vice versa. Workflow code that uses these helpers must
 * be bundled with `@temporalio/workflow` available at runtime;
 * activity code never reaches this module.
 *
 * v2 server endpoint required: bulk revoke against the workflow
 * run id. Until that endpoint lands, the activity stub here
 * raises so callers see a clear "not yet" message rather than a
 * silent no-op.
 */

import { defineSignal, proxyActivities, setHandler } from "@temporalio/workflow";

/**
 * Signal definition. Workflow code accepts `RevokeAtlaSentPermitsSignal`
 * via `setHandler` to register a revocation hook; external callers
 * fire it via `WorkflowHandle.signal(RevokeAtlaSentPermitsSignal,
 * { reason })`.
 *
 * The argument is a structured object so future fields can be added
 * without breaking external signal callers.
 */
export interface RevokeAtlaSentPermitsArgs {
  /**
   * Human-readable reason for the revoke. Persisted in the audit
   * chain alongside the bulk-revoke entry.
   */
  reason: string;
  /**
   * Optional explicit revoker id (operator / system). Defaults to
   * the workflow's own identity (`workflowExecution.workflowId`)
   * when the activity stub fills in the bulk-revoke request.
   */
  revoker_id?: string;
}

export const RevokeAtlaSentPermitsSignal = defineSignal<
  [RevokeAtlaSentPermitsArgs]
>("revokeAtlaSentPermits");

/**
 * Activity proxy used by the default signal handler. Customers who
 * already have their own activity bundle can register the signal
 * with their own activity reference; this is the convenience path.
 *
 * The activity itself is in `./bulkRevokeActivity.ts` and currently
 * stubs out — bulk revoke needs a v2 server endpoint that hasn't
 * landed (tracked in PR #57).
 */
export interface BulkRevokeActivities {
  bulkRevokeAtlaSentPermits(
    args: RevokeAtlaSentPermitsArgs & { run_id: string; workflow_id: string },
  ): Promise<void>;
}

/**
 * Default signal-handler installer. Call once at workflow start to
 * wire `RevokeAtlaSentPermitsSignal` to the bulk-revoke activity:
 *
 * ```ts
 * import { installRevokeHandler } from "@atlasent/temporal-preview";
 *
 * export async function deployWorkflow() {
 *   installRevokeHandler();
 *   // ... workflow body ...
 * }
 * ```
 *
 * Inside the handler:
 *   1. Reads `WorkflowExecution.workflowId` and `runId` (live
 *      workflow state).
 *   2. Schedules the bulk-revoke activity with a long timeout
 *      (the server-side bulk revoke can be slow on large permit
 *      sets; default 30s).
 *
 * Pass an `activityOptions` argument to override timeouts /
 * retries; pass an `activities` argument to inject your own
 * activity reference (e.g. when your worker has a custom
 * activity bundle).
 */
export function installRevokeHandler(
  options: InstallRevokeHandlerOptions = {},
): void {
  const proxy =
    options.activities ??
    proxyActivities<BulkRevokeActivities>({
      startToCloseTimeout: options.startToCloseTimeout ?? "30s",
    });

  setHandler(RevokeAtlaSentPermitsSignal, async (args) => {
    // `Workflow.workflowInfo()` exposes the workflowId / runId
    // as a synchronous read inside a workflow handler.
    const { workflowInfo } = await import("@temporalio/workflow");
    const info = workflowInfo();
    await proxy.bulkRevokeAtlaSentPermits({
      ...args,
      workflow_id: info.workflowId,
      run_id: info.runId,
    });
  });
}

/** Options for {@link installRevokeHandler}. */
export interface InstallRevokeHandlerOptions {
  /** Custom activity reference. Defaults to a `proxyActivities` proxy. */
  activities?: BulkRevokeActivities;
  /** `startToClose` timeout passed to `proxyActivities`. */
  startToCloseTimeout?: string;
}
