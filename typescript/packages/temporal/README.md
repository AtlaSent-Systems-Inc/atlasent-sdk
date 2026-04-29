# `@atlasent/temporal-preview` — PREVIEW, DO NOT USE IN PRODUCTION

> **Status:** DRAFT v2 preview. Marked `private: true` until v2 GA.
> Every export is subject to change without semver discipline.

Temporal adapter for AtlaSent. Wraps a Temporal Activity function
with `protect()` from `@atlasent/sdk` (v1) so every Activity
invocation goes through `evaluate → verifyPermit → execute`,
producing one audit-chain entry per Activity attempt.

## Why a separate preview package?

1. **Optional peer dep**: not every AtlaSent customer uses
   Temporal. Keeping the wrapper out of `@atlasent/sdk`'s main
   surface means non-Temporal users don't pay the
   `@temporalio/activity` import cost.
2. **No v1 changes**: this package wraps v1's `protect()` but
   doesn't modify it. v1 ships tomorrow without disturbance.
3. **v2-track**: the eventual server-side Pillar 9 consume +
   bulk-revoke surface (PR #61, PR #60) integrates here at v2 GA.
   For now this preview only exercises v1 behavior.

## What's in here

```ts
import { withAtlaSentActivity } from "@atlasent/temporal-preview";

const protectedDeploy = withAtlaSentActivity(deployActivity, {
  action: "deploy_to_production",
  context: (input) => ({ commit: input.commit }),
});
```

`withAtlaSentActivity(activityFn, options)` returns a new function
with the same signature as `activityFn`. Each call:

1. Resolves `action` and `context` (literals or async resolver
   functions of the activity input).
2. Reads `Context.current().info.workflowExecution.runId` and
   `info.workflowExecution.workflowId` to bind the permit to the
   workflow instance.
3. Calls `protect()` from `@atlasent/sdk`. On deny, throws
   `AtlaSentDeniedError` — Temporal records the activity failure
   and the workflow handles it.
4. On allow, runs `activityFn(input)` and returns its result.

## Workflow-side helpers

Pillar 8 also calls for a workflow signal that triggers bulk revoke
of every permit issued under a workflow run id. The signal +
default handler are exported from this package; the activity that
actually performs the revoke stubs out until the v2 server endpoint
lands.

```ts
// In workflow code (separate bundle from activity code):
import {
  installRevokeHandler,
  RevokeAtlaSentPermitsSignal,
} from "@atlasent/temporal-preview";

export async function deployWorkflow(input: DeployInput) {
  installRevokeHandler();          // wires the signal once
  // ... workflow body ...
}

// In external code firing the signal:
await client.workflow
  .getHandle(workflowId)
  .signal(RevokeAtlaSentPermitsSignal, { reason: "operator pause" });
```

The default handler:

1. Reads `workflowInfo()` to get `workflowId` + `runId`.
2. Schedules a `bulkRevokeAtlaSentPermits` activity (30s
   `startToCloseTimeout` by default) with `{ workflow_id, run_id,
   reason, revoker_id? }`.

`installRevokeHandler({ activities: ..., startToCloseTimeout: ... })`
overrides either piece. The default activity throws
`BulkRevokeNotImplementedError` until the v2 server endpoint
(`POST /v2/permits:bulk-revoke`) lands; customers can register
their own activity reference today to wire a per-permit revoke
loop against the existing v1 surface.

## What's NOT in here

- **The v2 callback / consume flow.** That requires server-side
  endpoints from PR #61. Once those land, this package extends
  to call `consume` after the Activity completes and surface the
  resulting Proof to the workflow via Activity result metadata.
- **`@temporalio/workflow` imports inside `withAtlaSentActivity`.**
  Temporal forbids workflow code from importing activity-side APIs
  and vice versa — workflow-side concerns live in
  `./workflowSignals.ts` which only Workflow code imports.

## Installation (dev)

The package isn't published yet (`private: true`). For local
development:

```bash
cd typescript/packages/temporal
npm install
npm test
```

`@temporalio/activity` is a peer dep — required at runtime, but
versions ≥ 1.0.0 work. `@atlasent/sdk` is similarly a peer dep.

## Relationship to v1

Wraps `protect()` from `@atlasent/sdk@^1.4.0`. No v1 modifications;
the wrapper only depends on the documented public API.
