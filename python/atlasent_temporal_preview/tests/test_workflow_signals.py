"""Tests for the workflow-side signal helpers and bulk-revoke activity.

Strategy:
  * The signal name is the cross-language constant.
  * Without ATLASENT_API_KEY, the activity raises BulkRevokeNotImplementedError
    with workflow context in the message.
  * With ATLASENT_API_KEY set, the activity creates a V2 client and calls
    bulk_revoke() — tested via make_bulk_revoke_activity with a mock client.
  * make_bulk_revoke_activity wires a pre-built client (DI path).

Activities are tested by direct call (not via a Temporal worker)
so the test is fast + deterministic. The full Temporal lifecycle
is exercised by integration suites in atlasent-examples — out of
scope for this preview package.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from atlasent_temporal_preview import (
    REVOKE_SIGNAL_NAME,
    BulkRevokeNotImplementedError,
    bulk_revoke_atlasent_permits,
    make_bulk_revoke_activity,
)


class TestSignalName:
    def test_matches_cross_language_constant(self):
        assert REVOKE_SIGNAL_NAME == "revokeAtlaSentPermits"


class TestBulkRevokeNoApiKey:
    """When ATLASENT_API_KEY is absent the activity raises clearly."""

    async def test_raises_bulk_revoke_not_implemented(self):
        with patch.dict("os.environ", {}, clear=False):
            # Ensure the key is absent.
            import os
            os.environ.pop("ATLASENT_API_KEY", None)
            os.environ.pop("ATLASENT_V2_API_KEY", None)
            with pytest.raises(BulkRevokeNotImplementedError):
                await bulk_revoke_atlasent_permits(
                    {
                        "reason": "operator pause",
                        "workflow_id": "wf-1",
                        "run_id": "run-abc",
                    }
                )

    async def test_error_message_names_workflow_run_and_reason(self):
        import os
        os.environ.pop("ATLASENT_API_KEY", None)
        os.environ.pop("ATLASENT_V2_API_KEY", None)
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
        import os
        os.environ.pop("ATLASENT_API_KEY", None)
        os.environ.pop("ATLASENT_V2_API_KEY", None)
        with pytest.raises(BulkRevokeNotImplementedError) as excinfo:
            await bulk_revoke_atlasent_permits({})
        msg = str(excinfo.value)
        assert "<unknown>" in msg
        assert "<no reason>" in msg

    def test_typed_error_class_inherits_from_runtime_error(self):
        assert issubclass(BulkRevokeNotImplementedError, RuntimeError)


class TestBulkRevokeWithApiKey:
    """When ATLASENT_API_KEY is present the activity calls bulk_revoke()."""

    async def test_calls_v2_client_bulk_revoke(self):
        mock_client = MagicMock()
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)

        with patch.dict("os.environ", {"ATLASENT_API_KEY": "ask_test_key"}):
            with patch("atlasent_v2_alpha.AtlaSentV2Client", return_value=mock_client):
                await bulk_revoke_atlasent_permits(
                    {
                        "workflow_id": "wf-deploy",
                        "run_id": "run-99",
                        "reason": "emergency",
                        "revoker_id": "ops-bot",
                    }
                )
        mock_client.bulk_revoke.assert_called_once_with(
            workflow_id="wf-deploy",
            run_id="run-99",
            reason="emergency",
            revoker_id="ops-bot",
        )

    async def test_omits_revoker_id_when_absent(self):
        mock_client = MagicMock()
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)

        with patch.dict("os.environ", {"ATLASENT_API_KEY": "ask_test_key"}):
            with patch("atlasent_v2_alpha.AtlaSentV2Client", return_value=mock_client):
                await bulk_revoke_atlasent_permits(
                    {
                        "workflow_id": "wf-x",
                        "run_id": "run-x",
                        "reason": "ttl",
                    }
                )
        call_kwargs = mock_client.bulk_revoke.call_args[1]
        assert call_kwargs.get("revoker_id") is None

    async def test_accepts_atlasent_v2_api_key_fallback(self):
        mock_client = MagicMock()
        mock_client.__enter__ = MagicMock(return_value=mock_client)
        mock_client.__exit__ = MagicMock(return_value=False)

        import os
        os.environ.pop("ATLASENT_API_KEY", None)
        with patch.dict("os.environ", {"ATLASENT_V2_API_KEY": "ask_v2_key"}):
            with patch("atlasent_v2_alpha.AtlaSentV2Client", return_value=mock_client):
                await bulk_revoke_atlasent_permits(
                    {"workflow_id": "wf", "run_id": "run", "reason": "test"}
                )
        mock_client.bulk_revoke.assert_called_once()


class TestMakeBulkRevokeActivity:
    """make_bulk_revoke_activity injects a pre-built client."""

    async def test_calls_injected_client(self):
        mock_client = MagicMock()
        activity_fn = make_bulk_revoke_activity(mock_client)
        await activity_fn(
            {
                "workflow_id": "wf-1",
                "run_id": "run-1",
                "reason": "operator pause",
                "revoker_id": "alice",
            }
        )
        mock_client.bulk_revoke.assert_called_once_with(
            workflow_id="wf-1",
            run_id="run-1",
            reason="operator pause",
            revoker_id="alice",
        )

    async def test_omits_revoker_id_when_absent(self):
        mock_client = MagicMock()
        activity_fn = make_bulk_revoke_activity(mock_client)
        await activity_fn(
            {
                "workflow_id": "wf",
                "run_id": "run",
                "reason": "ttl",
            }
        )
        call_kwargs = mock_client.bulk_revoke.call_args[1]
        assert call_kwargs.get("revoker_id") is None

    def test_factory_activity_has_correct_temporal_name(self):
        mock_client = MagicMock()
        activity_fn = make_bulk_revoke_activity(mock_client)
        defn = getattr(activity_fn, "__temporal_activity_definition", None)
        if defn is None:
            assert activity_fn.__name__ == "_bulk_revoke"
        else:
            assert defn.name == "bulkRevokeAtlaSentPermits"


class TestActivityDecoratedName:
    def test_activity_name_matches_cross_language_constant(self):
        defn = getattr(
            bulk_revoke_atlasent_permits,
            "__temporal_activity_definition",
            None,
        )
        if defn is None:
            assert (
                bulk_revoke_atlasent_permits.__name__
                == "bulk_revoke_atlasent_permits"
            )
        else:
            assert defn.name == "bulkRevokeAtlaSentPermits"
