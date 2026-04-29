# `atlasent-temporal-preview` — PREVIEW, DO NOT USE IN PRODUCTION

> **Status:** DRAFT v2 preview. Version pinned at `2.0.0a0`. Every
> export is subject to change without semver discipline.

Python sibling of
[`@atlasent/temporal-preview`](../../typescript/packages/temporal/).
Same scope, same parity invariants — the Pillar 8 Temporal adapter
that wraps activities with v1's `protect()`.

## Why a separate package?

1. **Optional dep**: not every AtlaSent customer uses Temporal.
   Keeping the wrapper out of `atlasent`'s main surface means
   non-Temporal users don't pull `temporalio`.
2. **No v1 changes**: this package depends on v1's `protect()` but
   doesn't modify it. v1 ships to PyPI tomorrow undisturbed.
3. **v2-track**: the eventual server-side Pillar 9 consume +
   bulk-revoke surface (PR #61, PR #60) integrates here at v2 GA.

## What's in here

```python
from atlasent_temporal_preview import atlasent_activity

@atlasent_activity(
    action="deploy_to_production",
    context_builder=lambda input: {"commit": input["commit"]},
)
async def deploy(input: dict) -> str:
    ...
```

`atlasent_activity(...)` returns a decorator. Each call to the
decorated function:

1. Resolves `action`, `context_builder`, `agent` (literals or
   sync/async callables of the activity input).
2. Reads `temporalio.activity.info()` to bind the permit to the
   workflow run id (`workflow_id`, `run_id`, `attempt`).
3. Calls `protect()` from `atlasent` (v1). On deny, raises
   `AtlaSentDeniedError` — Temporal records the activity failure.
4. On allow, runs the original function and returns its result.

## Workflow-side helpers

Pillar 8 also calls for a workflow signal that triggers bulk revoke
of every permit issued under a workflow run id. The signal name +
typed args + default activity stub all ship in this package; the
workflow-side decorator wiring is left to user code (different
projects structure their workflow classes differently).

```python
from datetime import timedelta
from temporalio import workflow

from atlasent_temporal_preview import (
    REVOKE_SIGNAL_NAME,
    bulk_revoke_atlasent_permits,
)


@workflow.defn
class DeployWorkflow:
    def __init__(self) -> None:
        self._revoke_pending: dict | None = None

    @workflow.signal(name=REVOKE_SIGNAL_NAME)
    def revoke_atlasent_permits(self, args: dict) -> None:
        self._revoke_pending = args

    @workflow.run
    async def run(self, input: dict) -> str:
        # ... main workflow body ...
        if self._revoke_pending is not None:
            info = workflow.info()
            await workflow.execute_activity(
                bulk_revoke_atlasent_permits,
                {
                    **self._revoke_pending,
                    "workflow_id": info.workflow_id,
                    "run_id": info.run_id,
                },
                start_to_close_timeout=timedelta(seconds=30),
            )
        return "done"
```

The default `bulk_revoke_atlasent_permits` activity raises
`BulkRevokeNotImplementedError` until the v2 server endpoint
(`POST /v2/permits:bulk-revoke`) lands. Customers can register
their own activity instead — useful for wiring a per-permit revoke
loop against the existing v1 surface today.

`REVOKE_SIGNAL_NAME` is the cross-language constant (also exported
from `@atlasent/temporal-preview` as
`RevokeAtlaSentPermitsSignal`'s name) so external callers fire the
same signal regardless of which SDK built the workflow.

## What's NOT in here

- **The v2 callback / consume flow.** That requires server-side
  endpoints from PR #61. Once those land, this package extends to
  call `consume` after the activity completes.

## Installation (dev)

```bash
cd python/atlasent_temporal_preview
pip install -e '.[dev]'
pytest
```

`atlasent>=1.4.0` and `temporalio>=1.0.0` are hard runtime deps —
both are imported and don't gracefully degrade.

## Relationship to v1

Wraps `protect()` from `atlasent>=1.4.0`. No v1 modifications;
the wrapper only depends on the documented public API. Whether
this package eventually folds into `atlasent` as an `[temporal]`
optional extra (vs. staying separate) is one of PR #57's open
questions.
