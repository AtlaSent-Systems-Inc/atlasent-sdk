"""Activity-side bulk-revoke implementation.

Stubs out for now — the server-side bulk-revoke endpoint
(``POST /v2/permits:bulk-revoke`` keyed on workflow ``run_id``) is
part of v2 server work that hasn't landed (tracked in PR #57).

Customers wiring this preview today can either:

  1. Register the stub and accept that revoke calls raise with a
     clear "v2 endpoint required" message.
  2. Replace it in their worker registration with a custom activity
     that wires a per-permit revoke loop against the existing v1
     surface.

At v2 GA this stub becomes a real HTTP call against the server's
bulk-revoke endpoint.
"""

from __future__ import annotations

from typing import Any

from temporalio import activity


class BulkRevokeNotImplementedError(RuntimeError):
    """Raised by :func:`bulk_revoke_atlasent_permits` until the v2
    server endpoint ships. Distinct class so customer code can
    branch on it (``except BulkRevokeNotImplementedError``)."""


@activity.defn(name="bulkRevokeAtlaSentPermits")
async def bulk_revoke_atlasent_permits(args: dict[str, Any]) -> None:
    """Stub bulk-revoke activity.

    Throws :class:`BulkRevokeNotImplementedError` by default.
    Customers who register this without overriding should at least
    see a clear message rather than a silent no-op.
    """
    workflow_id = args.get("workflow_id", "<unknown>")
    run_id = args.get("run_id", "<unknown>")
    reason = args.get("reason", "<no reason>")
    raise BulkRevokeNotImplementedError(
        "bulk_revoke_atlasent_permits requires the v2 server endpoint "
        "(POST /v2/permits:bulk-revoke) which is not yet shipped. "
        f"Workflow {workflow_id} (run {run_id}) requested revoke; "
        f"reason: {reason}"
    )
