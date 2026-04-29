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

## What's NOT in here

- **The v2 callback / consume flow.** That requires server-side
  endpoints from PR #61. Once those land, this package extends
  to call `consume` after the Activity completes and surface the
  resulting Proof to the workflow via Activity result metadata.
- **Workflow-side helpers** (`revokeAtlaSentPermits()` signal
  helper). Those wrap the bulk-revoke endpoint, which is also
  v2 server-side. Forward-declared in PR #57's V2 plan.
- **`@temporalio/workflow` imports.** This package only wraps
  Activities; workflow-side concerns stay in user code until v2 GA.

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
