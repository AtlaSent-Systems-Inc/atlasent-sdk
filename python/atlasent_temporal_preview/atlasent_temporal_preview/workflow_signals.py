"""Workflow-side signal helpers for the Temporal adapter.

Python sibling of
``typescript/packages/temporal/src/workflowSignals.ts``. Same
signal name (``revokeAtlaSentPermits``), same enriched-args shape,
same v2-server-endpoint deferral.

Pillar 8 piece called out in PR #57's V2 plan:

    Revocation signal: Workflow signal ``revokeAtlaSentPermits()``
    calls the server-side bulk revoke keyed on the workflow run id.

Workflow code that uses these helpers must be running inside a
Temporal worker (``temporalio.workflow`` is callable). Activity
code never reaches this module.

Usage::

    from datetime import timedelta

    from atlasent_temporal_preview import (
        REVOKE_SIGNAL_NAME,
        bulk_revoke_atlasent_permits,
    )
    from temporalio import workflow


    @workflow.defn
    class DeployWorkflow:
        def __init__(self) -> None:
            self._revoke_pending: dict | None = None

        @workflow.signal(name=REVOKE_SIGNAL_NAME)
        def revoke_atlasent_permits(self, args: dict) -> None:
            # Runs inside the workflow's main coroutine; defer the
            # actual activity dispatch to the workflow's run loop.
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
"""

from __future__ import annotations

from typing import TypedDict

REVOKE_SIGNAL_NAME = "revokeAtlaSentPermits"
"""Wire-level signal name. Cross-language identical with the TS
``RevokeAtlaSentPermitsSignal`` defined in
``typescript/packages/temporal/src/workflowSignals.ts`` so external
callers fire the same name regardless of which SDK they used to
build the workflow.
"""


class RevokeAtlaSentPermitsArgs(TypedDict, total=False):
    """Structured signal arguments.

    Required:
      reason: human-readable reason for the revoke; persisted in the
        audit chain alongside the bulk-revoke entry.

    Optional:
      revoker_id: explicit revoker (operator / system). When omitted,
        the activity stub falls back to the workflow's own identity.
    """

    reason: str
    revoker_id: str


class BulkRevokeArgs(TypedDict, total=False):
    """Activity-side arg shape — workflow + run id are appended by
    the workflow handler before dispatch."""

    reason: str
    revoker_id: str
    workflow_id: str
    run_id: str
