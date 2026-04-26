/**
 * Activity-side bulk-revoke implementation. Stubs out for now —
 * the server-side bulk-revoke endpoint (`POST /v2/permits:bulk-revoke`
 * keyed on workflow `run_id`) is part of v2 server work that
 * hasn't landed (tracked in PR #57's V2 plan, called out in
 * `./workflowSignals.ts`).
 *
 * Customers wiring this preview today can either:
 *
 *   1. Register the stub and accept that revoke calls throw with
 *      a clear "v2 endpoint required" message.
 *   2. Pass their own `BulkRevokeActivities` to
 *      {@link installRevokeHandler} — useful if they want to wire
 *      their own per-permit revoke loop against the existing v1
 *      surface.
 *
 * At v2 GA this stub becomes a real HTTP call against the server's
 * bulk-revoke endpoint.
 */

import type { RevokeAtlaSentPermitsArgs } from "./workflowSignals.js";

/**
 * Stub bulk-revoke activity. Throws by default — customers who
 * register this without overriding should at least see a clear
 * message rather than a silent no-op.
 */
export async function bulkRevokeAtlaSentPermits(
  args: RevokeAtlaSentPermitsArgs & { run_id: string; workflow_id: string },
): Promise<void> {
  throw new BulkRevokeNotImplementedError(
    `bulkRevokeAtlaSentPermits requires the v2 server endpoint ` +
      `(POST /v2/permits:bulk-revoke) which is not yet shipped. ` +
      `Workflow ${args.workflow_id} (run ${args.run_id}) requested revoke; ` +
      `reason: ${args.reason}`,
  );
}

/** Thrown by the stub activity. Distinct class so customer code can branch. */
export class BulkRevokeNotImplementedError extends Error {
  readonly name = "BulkRevokeNotImplementedError";
  constructor(message: string) {
    super(message);
  }
}
