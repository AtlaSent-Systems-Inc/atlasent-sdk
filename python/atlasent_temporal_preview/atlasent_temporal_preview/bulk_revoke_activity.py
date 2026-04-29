"""Activity-side bulk-revoke implementation (Pillar 8).

Calls ``POST /v2/permits:bulk-revoke`` on the AtlaSent v2 server using
``AtlaSentV2Client`` from ``atlasent-v2-alpha``.  The activity reads
the API key from the ``ATLASENT_API_KEY`` environment variable on the
worker process — never pass keys through workflow signals.

If ``ATLASENT_API_KEY`` is not set, :class:`BulkRevokeNotImplementedError`
is raised with a clear message so the gap is visible in Temporal's
activity-failure event rather than a silent no-op.

Customers who want to inject a pre-built client (e.g. to share it
across activities or to test with a mock) should use
:func:`make_bulk_revoke_activity` instead of registering this function
directly.
"""

from __future__ import annotations

import os
from typing import Any

from temporalio import activity


class BulkRevokeNotImplementedError(RuntimeError):
    """Raised when ``ATLASENT_API_KEY`` is missing or the v2 endpoint
    is unreachable.  Distinct class so customer code can branch on it
    (``except BulkRevokeNotImplementedError``)."""


def make_bulk_revoke_activity(client: Any) -> Any:
    """Return a Temporal activity that bulk-revokes via an injected client.

    Useful when the worker already holds an ``AtlaSentV2Client`` instance
    and you want to avoid the implicit ``ATLASENT_API_KEY`` env-var read::

        from atlasent_v2_alpha import AtlaSentV2Client
        from atlasent_temporal_preview import make_bulk_revoke_activity

        client = AtlaSentV2Client(api_key=os.environ["ATLASENT_API_KEY"])
        worker = Worker(
            ...,
            activities=[make_bulk_revoke_activity(client)],
        )

    The returned function is decorated with ``@activity.defn`` and shares
    the same Temporal-registry name as the default activity so the
    workflow side needs no changes.
    """

    @activity.defn(name="bulkRevokeAtlaSentPermits")
    async def _bulk_revoke(args: dict[str, Any]) -> None:
        client.bulk_revoke(
            workflow_id=args.get("workflow_id", ""),
            run_id=args.get("run_id", ""),
            reason=args.get("reason", ""),
            revoker_id=args.get("revoker_id"),
        )

    return _bulk_revoke


@activity.defn(name="bulkRevokeAtlaSentPermits")
async def bulk_revoke_atlasent_permits(args: dict[str, Any]) -> None:
    """Bulk-revoke activity — reads ``ATLASENT_API_KEY`` from the environment.

    Raises :class:`BulkRevokeNotImplementedError` when the env var is
    absent so the failure is visible and actionable rather than silent.
    """
    workflow_id = args.get("workflow_id", "<unknown>")
    run_id = args.get("run_id", "<unknown>")
    reason = args.get("reason", "<no reason>")
    revoker_id = args.get("revoker_id")

    api_key = os.environ.get("ATLASENT_API_KEY") or os.environ.get(
        "ATLASENT_V2_API_KEY"
    )
    if not api_key:
        raise BulkRevokeNotImplementedError(
            "bulk_revoke_atlasent_permits requires the ATLASENT_API_KEY "
            "env var on the worker process (wires against "
            "POST /v2/permits:bulk-revoke). "
            f"Workflow {workflow_id} (run {run_id}) requested revoke; "
            f"reason: {reason}"
        )

    from atlasent_v2_alpha import AtlaSentV2Client

    with AtlaSentV2Client(api_key=api_key) as v2_client:
        v2_client.bulk_revoke(
            workflow_id=workflow_id,
            run_id=run_id,
            reason=reason,
            revoker_id=revoker_id,
        )
