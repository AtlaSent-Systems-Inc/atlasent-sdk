"""Policy sync run models and helper utilities.

Parity with ``typescript/src/policySync.ts``.

Submit a policy bundle to ``POST /v1/policy-sync`` with
``dry_run=True`` to preview the diff, or ``dry_run=False`` to apply
it immediately.  A completed dry-run can also be applied via
``POST /v1/policy-sync/:id/apply``.

Quick start::

    from atlasent.policy_sync import (
        PolicySyncRun,
        format_policy_sync_diff,
        is_policy_sync_terminal,
    )

    run: PolicySyncRun = ...  # from API response
    print(format_policy_sync_diff(run))  # "+2 added, ~1 updated"
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Literals
# ---------------------------------------------------------------------------

PolicySyncStatus = Literal[
    "pending",
    "validating",
    "applying",
    "completed",
    "failed",
    "rejected",
]
"""
Lifecycle status of a policy sync run:

- ``"pending"`` — queued, not yet started.
- ``"validating"`` — parsing and validating bundle entries.
- ``"applying"`` — writing policy changes (live runs only).
- ``"completed"`` — finished successfully.
- ``"failed"`` — internal processing error.
- ``"rejected"`` — bundle failed validation.
"""

_TERMINAL_STATUSES: frozenset[str] = frozenset({"completed", "failed", "rejected"})

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class PolicyBundleEntry(BaseModel):
    """One policy entry inside a sync bundle.

    ``name`` is the stable key used for diffing: a policy with an
    existing name is *updated*; a new name is *added*; names absent
    from the bundle are *removed*.
    """

    name: str
    body: str
    description: str | None = None
    tags: list[str] = Field(default_factory=list)

    model_config = {"extra": "allow"}


class PolicySyncDiff(BaseModel):
    """Structured diff returned inside a sync run."""

    added: list[str] = Field(default_factory=list)
    updated: list[str] = Field(default_factory=list)
    removed: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)

    model_config = {"extra": "allow"}


class PolicySyncRun(BaseModel):
    """A policy sync run returned by ``POST /v1/policy-sync``
    or ``GET /v1/policy-sync/:id``.

    When ``dry_run`` was ``True``, ``status`` will be ``"completed"``
    and ``diff`` is populated but no policies are changed.  Call
    ``POST /v1/policy-sync/:id/apply`` to apply the previewed diff.
    """

    id: str
    org_id: str
    source: str = ""
    commit_sha: str | None = None
    ref: str | None = None
    bundle_hash: str = ""
    status: PolicySyncStatus
    policies_added: int = 0
    policies_updated: int = 0
    policies_removed: int = 0
    diff: PolicySyncDiff | None = None
    applied_by: str | None = None
    created_at: str = ""

    model_config = {"extra": "allow"}


class SubmitPolicySyncRequest(BaseModel):
    """Request body for ``POST /v1/policy-sync``."""

    policies: list[PolicyBundleEntry]
    source: str | None = None
    commit_sha: str | None = None
    ref: str | None = None
    dry_run: bool = False

    model_config = {"extra": "allow"}


# ---------------------------------------------------------------------------
# Utility functions
# ---------------------------------------------------------------------------


def format_policy_sync_diff(run: PolicySyncRun) -> str:
    """Return a human-readable one-line diff summary.

    Examples::

        "+3 added, ~1 updated, -2 removed"
        "no changes"
    """
    parts: list[str] = []
    if run.policies_added > 0:
        parts.append(f"+{run.policies_added} added")
    if run.policies_updated > 0:
        parts.append(f"~{run.policies_updated} updated")
    if run.policies_removed > 0:
        parts.append(f"-{run.policies_removed} removed")
    return ", ".join(parts) if parts else "no changes"


def is_policy_sync_terminal(run: PolicySyncRun) -> bool:
    """Return ``True`` when the run has reached a terminal status.

    Terminal statuses: ``"completed"``, ``"failed"``, ``"rejected"``.
    Use this to break a polling loop::

        while not is_policy_sync_terminal(run):
            time.sleep(2)
            run = fetch_run(run.id)
    """
    return run.status in _TERMINAL_STATUSES
