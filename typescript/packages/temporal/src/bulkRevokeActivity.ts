/**
 * Activity-side bulk-revoke implementation (Pillar 8).
 *
 * Calls `POST /v2/permits:bulk-revoke` on the AtlaSent v2 server using
 * `V2Client` from `@atlasent/sdk-v2-alpha`. The activity reads the API key
 * from `process.env.ATLASENT_API_KEY` on the worker process — never pass
 * keys through workflow signals.
 *
 * If `ATLASENT_API_KEY` is not set, {@link BulkRevokeNotImplementedError}
 * is thrown with a clear message so the gap is visible in Temporal's
 * activity-failure event rather than a silent no-op.
 *
 * Customers who want to inject a pre-built client (e.g. to share it across
 * activities or to test with a mock) should use
 * {@link createBulkRevokeActivity} instead of registering this function
 * directly.
 */

import type { RevokeAtlaSentPermitsArgs } from "./workflowSignals.js";

/** Thrown when `ATLASENT_API_KEY` is absent or the v2 endpoint is unreachable.
 * Distinct class so customer code can branch on it. */
export class BulkRevokeNotImplementedError extends Error {
  readonly name = "BulkRevokeNotImplementedError";
  constructor(message: string) {
    super(message);
  }
}

type BulkRevokeArgs = RevokeAtlaSentPermitsArgs & {
  run_id: string;
  workflow_id: string;
};

/**
 * Return a Temporal activity that bulk-revokes via an injected client.
 *
 * Useful when the worker already holds a `V2Client` instance and you want
 * to avoid the implicit `ATLASENT_API_KEY` env-var read:
 *
 * ```ts
 * import { V2Client } from "@atlasent/sdk-v2-alpha";
 * import { createBulkRevokeActivity } from "@atlasent/temporal-preview";
 *
 * const client = new V2Client({ apiKey: process.env.ATLASENT_API_KEY! });
 * const worker = await Worker.create({
 *   activities: { bulkRevokeAtlaSentPermits: createBulkRevokeActivity(client) },
 * });
 * ```
 *
 * The returned function shares the same Temporal-registry name as the
 * default activity so the workflow side needs no changes.
 */
export function createBulkRevokeActivity(
  client: {
    bulkRevoke(input: {
      workflowId: string;
      runId: string;
      reason: string;
      revokerId?: string;
    }): Promise<unknown>;
  },
): (args: BulkRevokeArgs) => Promise<void> {
  return async function bulkRevokeAtlaSentPermits(args: BulkRevokeArgs) {
    await client.bulkRevoke({
      workflowId: args.workflow_id,
      runId: args.run_id,
      reason: args.reason,
      revokerId: args.revoker_id,
    });
  };
}

/**
 * Bulk-revoke activity — reads `ATLASENT_API_KEY` from the environment.
 *
 * Throws {@link BulkRevokeNotImplementedError} when the env var is absent
 * so the failure is visible and actionable rather than silent.
 */
export async function bulkRevokeAtlaSentPermits(
  args: BulkRevokeArgs,
): Promise<void> {
  const apiKey =
    process.env["ATLASENT_API_KEY"] ?? process.env["ATLASENT_V2_API_KEY"];

  if (!apiKey) {
    throw new BulkRevokeNotImplementedError(
      `bulkRevokeAtlaSentPermits requires the ATLASENT_API_KEY env var ` +
        `on the worker process (wires against POST /v2/permits:bulk-revoke). ` +
        `Workflow ${args.workflow_id} (run ${args.run_id}) requested revoke; ` +
        `reason: ${args.reason}`,
    );
  }

  const { V2Client } = await import("@atlasent/sdk-v2-alpha");
  const client = new V2Client({ apiKey });
  await client.bulkRevoke({
    workflowId: args.workflow_id,
    runId: args.run_id,
    reason: args.reason,
    revokerId: args.revoker_id,
  });
}
