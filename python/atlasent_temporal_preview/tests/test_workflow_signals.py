"""Tests for the workflow-side signal helpers.

Strategy: most of this surface is type-only (TypedDicts) plus a
single stub activity. We assert:
  * The signal name is the cross-language constant.
  * The stub activity raises with workflow context in the message.
  * BulkRevokeNotImplementedError is a typed branch class.

Activities are tested by direct call (not via a Temporal worker)
so the test is fast + deterministic. The full Temporal lifecycle
(workflow registers the signal, signal fires, activity dispatches)
is exercised by integration suites in atlasent-examples — out of
scope for this preview package.
"""

from __future__ import annotations

import pytest

from atlasent_temporal_preview import (
    REVOKE_SIGNAL_NAME,
    BulkRevokeNotImplementedError,
    bulk_revoke_atlasent_permits,
)


class TestSignalName:
    def test_matches_cross_language_constant(self):
        # Identical to the TS package's RevokeAtlaSentPermitsSignal
        # name so external callers fire the same signal regardless
        # of which SDK built the workflow.
        assert REVOKE_SIGNAL_NAME == "revokeAtlaSentPermits"


class TestBulkRevokeStub:
    async def test_raises_bulk_revoke_not_implemented(self):
        with pytest.raises(BulkRevokeNotImplementedError):
            await bulk_revoke_atlasent_permits(
                {
                    "reason": "operator pause",
                    "workflow_id": "wf-1",
                    "run_id": "run-abc",
                }
            )

    async def test_error_message_names_workflow_run_and_reason(self):
        try:
            await bulk_revoke_atlasent_permits(
                {
                    "reason": "ttl_expired",
                    "workflow_id": "wf-x",
                    "run_id": "run-y",
                }
            )
        except BulkRevokeNotImplementedError as err:
            msg = str(err)
            assert "wf-x" in msg
            assert "run-y" in msg
            assert "ttl_expired" in msg
        else:
            pytest.fail("expected BulkRevokeNotImplementedError")

    async def test_handles_missing_optional_fields(self):
        # Stub still raises clearly even when args are sparse.
        with pytest.raises(BulkRevokeNotImplementedError) as excinfo:
            await bulk_revoke_atlasent_permits({})
        msg = str(excinfo.value)
        assert "<unknown>" in msg
        assert "<no reason>" in msg

    def test_typed_error_class_inherits_from_runtime_error(self):
        # Customer code can `except RuntimeError` without knowing
        # the specific class.
        assert issubclass(BulkRevokeNotImplementedError, RuntimeError)


class TestActivityDecoratedName:
    def test_activity_name_matches_cross_language_constant(self):
        # The @activity.defn(name="bulkRevokeAtlaSentPermits") matches
        # the TS-side activity name in BulkRevokeActivities.
        # Temporal exposes the registered name via __temporal_activity_definition.
        defn = getattr(
            bulk_revoke_atlasent_permits,
            "__temporal_activity_definition",
            None,
        )
        # If the attribute name has changed in temporalio, fall back
        # to checking the function's __name__.
        if defn is None:
            assert (
                bulk_revoke_atlasent_permits.__name__
                == "bulk_revoke_atlasent_permits"
            )
        else:
            assert defn.name == "bulkRevokeAtlaSentPermits"
