"""Tests for atlasent.policy_sync."""

from __future__ import annotations

import pytest

from atlasent.policy_sync import (
    PolicyBundleEntry,
    PolicySyncDiff,
    PolicySyncRun,
    SubmitPolicySyncRequest,
    format_policy_sync_diff,
    is_policy_sync_terminal,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def make_run(
    status: str = "completed",
    added: int = 0,
    updated: int = 0,
    removed: int = 0,
) -> PolicySyncRun:
    return PolicySyncRun(
        id="psync_01",
        org_id="org_01",
        status=status,  # type: ignore[arg-type]
        policies_added=added,
        policies_updated=updated,
        policies_removed=removed,
    )


# ---------------------------------------------------------------------------
# format_policy_sync_diff
# ---------------------------------------------------------------------------


class TestFormatPolicySyncDiff:
    def test_no_changes(self) -> None:
        assert format_policy_sync_diff(make_run()) == "no changes"

    def test_added_only(self) -> None:
        assert format_policy_sync_diff(make_run(added=3)) == "+3 added"

    def test_updated_only(self) -> None:
        assert format_policy_sync_diff(make_run(updated=2)) == "~2 updated"

    def test_removed_only(self) -> None:
        assert format_policy_sync_diff(make_run(removed=1)) == "-1 removed"

    def test_add_update_remove(self) -> None:
        assert (
            format_policy_sync_diff(make_run(added=1, updated=2, removed=3))
            == "+1 added, ~2 updated, -3 removed"
        )

    def test_add_and_update(self) -> None:
        assert (
            format_policy_sync_diff(make_run(added=2, updated=1))
            == "+2 added, ~1 updated"
        )

    def test_update_and_remove(self) -> None:
        assert (
            format_policy_sync_diff(make_run(updated=1, removed=4))
            == "~1 updated, -4 removed"
        )

    def test_add_and_remove(self) -> None:
        assert (
            format_policy_sync_diff(make_run(added=5, removed=2))
            == "+5 added, -2 removed"
        )

    def test_single_added(self) -> None:
        assert format_policy_sync_diff(make_run(added=1)) == "+1 added"


# ---------------------------------------------------------------------------
# is_policy_sync_terminal
# ---------------------------------------------------------------------------


class TestIsPolicySyncTerminal:
    @pytest.mark.parametrize("status", ["completed", "failed", "rejected"])
    def test_terminal_statuses(self, status: str) -> None:
        assert is_policy_sync_terminal(make_run(status=status)) is True

    @pytest.mark.parametrize("status", ["pending", "validating", "applying"])
    def test_non_terminal_statuses(self, status: str) -> None:
        assert is_policy_sync_terminal(make_run(status=status)) is False


# ---------------------------------------------------------------------------
# PolicyBundleEntry model
# ---------------------------------------------------------------------------


class TestPolicyBundleEntry:
    def test_minimal(self) -> None:
        entry = PolicyBundleEntry(name="deploy-gate", body="allow if true")
        assert entry.name == "deploy-gate"
        assert entry.tags == []
        assert entry.description is None

    def test_full(self) -> None:
        entry = PolicyBundleEntry(
            name="deploy-gate",
            body="allow if actor.role == 'deployer'",
            description="Gate deploys by role",
            tags=["deployment", "production"],
        )
        assert entry.description == "Gate deploys by role"
        assert "production" in entry.tags

    def test_round_trips_from_dict(self) -> None:
        data = {
            "name": "financial-gate",
            "body": "allow if amount_usd < 10000",
            "tags": ["financial"],
        }
        entry = PolicyBundleEntry.model_validate(data)
        assert entry.name == "financial-gate"


# ---------------------------------------------------------------------------
# PolicySyncRun model
# ---------------------------------------------------------------------------


class TestPolicySyncRun:
    def test_round_trips_from_dict(self) -> None:
        data = {
            "id": "psync_01",
            "org_id": "org_01",
            "source": "github-action",
            "commit_sha": "abc1234",
            "ref": "refs/heads/main",
            "bundle_hash": "sha256:deadbeef",
            "status": "completed",
            "policies_added": 2,
            "policies_updated": 1,
            "policies_removed": 0,
            "diff": {
                "added": ["policy-a", "policy-b"],
                "updated": ["policy-c"],
                "removed": [],
            },
            "created_at": "2026-05-07T00:00:00Z",
        }
        run = PolicySyncRun.model_validate(data)
        assert run.status == "completed"
        assert run.policies_added == 2
        assert run.diff is not None
        assert len(run.diff.added) == 2

    def test_diff_defaults_to_none(self) -> None:
        run = PolicySyncRun.model_validate({
            "id": "psync_02",
            "org_id": "org_01",
            "status": "pending",
        })
        assert run.diff is None

    def test_extra_fields_allowed(self) -> None:
        run = PolicySyncRun.model_validate({
            "id": "psync_03",
            "org_id": "org_01",
            "status": "validating",
            "future_field": "x",
        })
        assert run.id == "psync_03"


# ---------------------------------------------------------------------------
# SubmitPolicySyncRequest model
# ---------------------------------------------------------------------------


class TestSubmitPolicySyncRequest:
    def test_dry_run_defaults_false(self) -> None:
        req = SubmitPolicySyncRequest(
            policies=[PolicyBundleEntry(name="p", body="allow if true")]
        )
        assert req.dry_run is False

    def test_dry_run_true(self) -> None:
        req = SubmitPolicySyncRequest(
            policies=[PolicyBundleEntry(name="p", body="allow if true")],
            dry_run=True,
        )
        assert req.dry_run is True

    def test_serialises_to_wire_format(self) -> None:
        req = SubmitPolicySyncRequest(
            policies=[PolicyBundleEntry(name="gate", body="allow if true")],
            source="ci",
            commit_sha="abc",
            dry_run=True,
        )
        d = req.model_dump()
        assert d["dry_run"] is True
        assert d["source"] == "ci"
        assert d["policies"][0]["name"] == "gate"
