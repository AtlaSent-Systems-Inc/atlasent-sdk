"""Tests for ``atlasent.with_permit`` (sync) and ``atlasent.aio.with_permit``
(async). Mirrors the TypeScript SDK's ``test/with-permit.test.ts``
including the v1 single-use replay-protection invariant."""

from __future__ import annotations

import httpx
import pytest

import atlasent.aio as atlasent_aio
from atlasent import (
    AsyncAtlaSentClient,
    AtlaSentClient,
    AtlaSentDeniedError,
    AtlaSentError,
    Permit,
    with_permit,
)
from atlasent.authorize import _reset_default_client
from atlasent.config import configure

# ── Wire fixtures (kept identical to test_protect.py for parity) ───────

EVALUATE_PERMIT = {
    "permitted": True,
    "decision_id": "dec_alpha",
    "reason": "policy authorized",
    "audit_hash": "hash_alpha",
    "timestamp": "2026-04-29T18:00:00Z",
}

EVALUATE_DENY = {
    "permitted": False,
    "decision_id": "dec_beta",
    "reason": "missing change_reason",
    "audit_hash": "hash_beta",
    "timestamp": "2026-04-29T18:00:00Z",
}

VERIFY_OK = {
    "verified": True,
    "outcome": "verified",
    "permit_hash": "permit_alpha",
    "timestamp": "2026-04-29T18:00:01Z",
}

VERIFY_CONSUMED = {
    "verified": False,
    "outcome": "permit_consumed",
    "permit_hash": "permit_alpha",
    "timestamp": "2026-04-29T18:00:01Z",
}


def _mock_resp(mocker, status_code: int = 200, json_data: dict | None = None):
    resp = mocker.Mock(spec=httpx.Response)
    resp.status_code = status_code
    resp.headers = {}
    resp.text = ""
    if json_data is not None:
        resp.json.return_value = json_data
    return resp


# ── Sync: atlasent.with_permit ─────────────────────────────────────────


class TestSyncWithPermit:
    def setup_method(self) -> None:
        _reset_default_client()
        configure(api_key="ask_test")

    def teardown_method(self) -> None:
        _reset_default_client()

    def test_invokes_fn_with_verified_permit(self, mocker) -> None:
        client = AtlaSentClient(api_key="ask_test", max_retries=0)
        mocker.patch("atlasent.authorize._get_default_client", return_value=client)
        mocker.patch.object(
            client._client,
            "post",
            side_effect=[
                _mock_resp(mocker, json_data=EVALUATE_PERMIT),
                _mock_resp(mocker, json_data=VERIFY_OK),
            ],
        )

        seen: list[Permit] = []

        def fn(permit: Permit) -> str:
            seen.append(permit)
            return "ran"

        result = with_permit(
            agent="deploy-bot", action="deploy", context={"commit": "abc"}, fn=fn
        )

        assert result == "ran"
        assert len(seen) == 1
        assert seen[0].permit_id == "dec_alpha"
        assert seen[0].permit_hash == "permit_alpha"

    def test_raises_denied_on_policy_deny_fn_never_called(self, mocker) -> None:
        client = AtlaSentClient(api_key="ask_test", max_retries=0)
        mocker.patch("atlasent.authorize._get_default_client", return_value=client)
        mocker.patch.object(
            client._client,
            "post",
            return_value=_mock_resp(mocker, json_data=EVALUATE_DENY),
        )

        called = False

        def fn(_permit: Permit) -> str:
            nonlocal called
            called = True
            return "should-not-run"

        with pytest.raises(AtlaSentDeniedError):
            with_permit(agent="bot", action="deploy", fn=fn)
        assert called is False

    def test_replay_v1_single_use_raises_denied_fn_never_called(self, mocker) -> None:
        """v1 replay protection: server reports verified=false /
        outcome=permit_consumed on a re-verify. with_permit MUST raise
        AtlaSentDeniedError and MUST NOT invoke fn."""
        client = AtlaSentClient(api_key="ask_test", max_retries=0)
        mocker.patch("atlasent.authorize._get_default_client", return_value=client)
        mocker.patch.object(
            client._client,
            "post",
            side_effect=[
                _mock_resp(mocker, json_data=EVALUATE_PERMIT),
                _mock_resp(mocker, json_data=VERIFY_CONSUMED),
            ],
        )

        called = False

        def fn(_permit: Permit) -> str:
            nonlocal called
            called = True
            return "should-not-run"

        with pytest.raises(AtlaSentDeniedError) as exc_info:
            with_permit(agent="bot", action="deploy", fn=fn)
        assert called is False
        assert "permit_consumed" in (exc_info.value.reason or "").lower() or (
            "verification" in str(exc_info.value).lower()
        )

    def test_fn_exception_propagates_verbatim(self, mocker) -> None:
        client = AtlaSentClient(api_key="ask_test", max_retries=0)
        mocker.patch("atlasent.authorize._get_default_client", return_value=client)
        mocker.patch.object(
            client._client,
            "post",
            side_effect=[
                _mock_resp(mocker, json_data=EVALUATE_PERMIT),
                _mock_resp(mocker, json_data=VERIFY_OK),
            ],
        )

        class CallerError(RuntimeError):
            pass

        def fn(_permit: Permit) -> str:
            raise CallerError("user code blew up")

        with pytest.raises(CallerError, match="user code blew up"):
            with_permit(agent="bot", action="deploy", fn=fn)

    def test_5xx_on_evaluate_raises_atlasent_error_fn_never_called(
        self, mocker
    ) -> None:
        client = AtlaSentClient(api_key="ask_test", max_retries=0)
        mocker.patch("atlasent.authorize._get_default_client", return_value=client)
        resp = _mock_resp(mocker, status_code=500)
        resp.text = "Internal Server Error"
        mocker.patch.object(client._client, "post", return_value=resp)

        called = False

        def fn(_permit: Permit) -> str:
            nonlocal called
            called = True
            return "should-not-run"

        with pytest.raises(AtlaSentError):
            with_permit(agent="bot", action="deploy", fn=fn)
        assert called is False

    def test_returns_arbitrary_fn_return_value(self, mocker) -> None:
        client = AtlaSentClient(api_key="ask_test", max_retries=0)
        mocker.patch("atlasent.authorize._get_default_client", return_value=client)
        mocker.patch.object(
            client._client,
            "post",
            side_effect=[
                _mock_resp(mocker, json_data=EVALUATE_PERMIT),
                _mock_resp(mocker, json_data=VERIFY_OK),
            ],
        )

        result = with_permit(
            agent="bot",
            action="deploy",
            fn=lambda permit: {"ok": True, "id": permit.permit_id},
        )
        assert result == {"ok": True, "id": "dec_alpha"}

    def test_exposed_as_top_level_import(self) -> None:
        """The function MUST be importable from `atlasent` directly so
        `from atlasent import with_permit` works for downstream code."""
        from atlasent import with_permit as imported  # noqa: F401

        assert imported is with_permit


# ── Async: atlasent.aio.with_permit ────────────────────────────────────


@pytest.fixture
def async_client() -> AsyncAtlaSentClient:
    return AsyncAtlaSentClient(api_key="ask_test", max_retries=0)


class TestAsyncWithPermit:
    @pytest.mark.asyncio
    async def test_invokes_async_fn_with_verified_permit(
        self, async_client, mocker
    ) -> None:
        mocker.patch.object(
            async_client._client,
            "post",
            side_effect=[
                _mock_resp(mocker, json_data=EVALUATE_PERMIT),
                _mock_resp(mocker, json_data=VERIFY_OK),
            ],
        )

        seen: list[Permit] = []

        async def fn(permit: Permit) -> str:
            seen.append(permit)
            return "ran-async"

        result = await atlasent_aio.with_permit(
            async_client, agent="bot", action="deploy", fn=fn
        )

        assert result == "ran-async"
        assert seen[0].permit_id == "dec_alpha"

    @pytest.mark.asyncio
    async def test_invokes_sync_fn_under_async_wrapper(
        self, async_client, mocker
    ) -> None:
        mocker.patch.object(
            async_client._client,
            "post",
            side_effect=[
                _mock_resp(mocker, json_data=EVALUATE_PERMIT),
                _mock_resp(mocker, json_data=VERIFY_OK),
            ],
        )

        result = await atlasent_aio.with_permit(
            async_client,
            agent="bot",
            action="deploy",
            fn=lambda permit: ("sync-result", permit.permit_id),
        )
        assert result == ("sync-result", "dec_alpha")

    @pytest.mark.asyncio
    async def test_replay_consumed_raises_denied_fn_never_called(
        self, async_client, mocker
    ) -> None:
        mocker.patch.object(
            async_client._client,
            "post",
            side_effect=[
                _mock_resp(mocker, json_data=EVALUATE_PERMIT),
                _mock_resp(mocker, json_data=VERIFY_CONSUMED),
            ],
        )

        called = False

        async def fn(_permit: Permit) -> str:
            nonlocal called
            called = True
            return "should-not-run"

        with pytest.raises(AtlaSentDeniedError):
            await atlasent_aio.with_permit(
                async_client, agent="bot", action="deploy", fn=fn
            )
        assert called is False

    @pytest.mark.asyncio
    async def test_async_fn_exception_propagates_verbatim(
        self, async_client, mocker
    ) -> None:
        mocker.patch.object(
            async_client._client,
            "post",
            side_effect=[
                _mock_resp(mocker, json_data=EVALUATE_PERMIT),
                _mock_resp(mocker, json_data=VERIFY_OK),
            ],
        )

        class CallerError(RuntimeError):
            pass

        async def fn(_permit: Permit) -> str:
            raise CallerError("async user code blew up")

        with pytest.raises(CallerError, match="async user code blew up"):
            await atlasent_aio.with_permit(
                async_client, agent="bot", action="deploy", fn=fn
            )
