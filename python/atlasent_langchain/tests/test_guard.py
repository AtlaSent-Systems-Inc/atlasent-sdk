"""Tests for atlasent_langchain guards."""
from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock

from atlasent.exceptions import AtlaSentDeniedError

from atlasent_langchain import (
    DenialResult,
    async_with_langchain_guard,
    with_langchain_guard,
)


# ── Fixtures ──────────────────────────────────────────────────────────────────

class _Permit:
    permit_id = "dec_alpha"
    permit_hash = "hash_permit"
    audit_hash = "hash_alpha"
    reason = "authorized"
    timestamp = "2026-04-29T10:00:00Z"


def _denied_error() -> AtlaSentDeniedError:
    return AtlaSentDeniedError(
        decision="deny",
        evaluation_id="dec_beta",
        reason="policy denied",
        audit_hash="hash_beta",
    )


def make_sync_client(raise_exc: Exception | None = None) -> MagicMock:
    client = MagicMock()
    if raise_exc is not None:
        client.protect.side_effect = raise_exc
    else:
        client.protect.return_value = _Permit()
    return client


def make_async_client(raise_exc: Exception | None = None) -> MagicMock:
    client = MagicMock()
    if raise_exc is not None:
        client.protect = AsyncMock(side_effect=raise_exc)
    else:
        client.protect = AsyncMock(return_value=_Permit())
    return client


# ── with_langchain_guard (sync) ───────────────────────────────────────────────

class TestWithLangChainGuard:
    def test_executes_func_and_returns_result(self) -> None:
        def search(query: str) -> str:
            return f"results:{query}"

        client = make_sync_client()
        guarded = with_langchain_guard(search, client, agent="bot")
        assert guarded(query="hello") == "results:hello"

    def test_calls_protect_with_correct_args(self) -> None:
        def search(query: str) -> str:
            return ""

        client = make_sync_client()
        guarded = with_langchain_guard(search, client, agent="svc:app")
        guarded(query="x")

        client.protect.assert_called_once_with(
            agent="svc:app",
            action="search",
            context={"tool_input": {"query": "x"}},
        )

    def test_uses_custom_action(self) -> None:
        def fn() -> str:
            return ""

        client = make_sync_client()
        guarded = with_langchain_guard(fn, client, agent="bot", action="custom_action")
        guarded()

        _, kwargs = client.protect.call_args
        assert kwargs["action"] == "custom_action"

    def test_annotates_dict_result(self) -> None:
        def fetch() -> dict:
            return {"value": 42}

        client = make_sync_client()
        guarded = with_langchain_guard(fetch, client, agent="bot")
        result = guarded()

        assert result["value"] == 42
        assert result["_atlasent_permit_id"] == "dec_alpha"
        assert result["_atlasent_audit_hash"] == "hash_alpha"

    def test_passes_through_non_dict_result(self) -> None:
        def count() -> int:
            return 7

        client = make_sync_client()
        guarded = with_langchain_guard(count, client, agent="bot")
        assert guarded() == 7

    def test_raises_on_deny_by_default(self) -> None:
        def fn() -> str:
            return ""

        client = make_sync_client(raise_exc=_denied_error())
        guarded = with_langchain_guard(fn, client, agent="bot")
        with pytest.raises(AtlaSentDeniedError):
            guarded()

    def test_returns_denial_result_when_on_deny_tool_result(self) -> None:
        def fn() -> str:
            return ""

        client = make_sync_client(raise_exc=_denied_error())
        guarded = with_langchain_guard(fn, client, agent="bot", on_deny="tool-result")
        result = guarded()

        assert isinstance(result, DenialResult)
        assert result.denied is True

    def test_surfaces_transport_errors_as_denial_result(self) -> None:
        def fn() -> str:
            return ""

        client = make_sync_client(raise_exc=ConnectionError("timeout"))
        guarded = with_langchain_guard(fn, client, agent="bot", on_deny="tool-result")
        result = guarded()

        assert isinstance(result, DenialResult)
        assert result.decision == "error"
        assert "timeout" in result.reason

    def test_preserves_name_and_docstring(self) -> None:
        def my_tool() -> str:
            """My tool docstring."""
            return ""

        guarded = with_langchain_guard(my_tool, make_sync_client(), agent="bot")
        assert guarded.__name__ == "my_tool"
        assert guarded.__doc__ == "My tool docstring."

    def test_forwards_extra_context(self) -> None:
        def fn() -> str:
            return ""

        client = make_sync_client()
        guarded = with_langchain_guard(
            fn, client, agent="bot", extra_context={"env": "prod"}
        )
        guarded()

        _, kwargs = client.protect.call_args
        assert kwargs["context"]["env"] == "prod"


# ── async_with_langchain_guard ────────────────────────────────────────────────

class TestAsyncWithLangChainGuard:
    async def test_executes_async_func(self) -> None:
        async def search(query: str) -> str:
            return f"async:{query}"

        client = make_async_client()
        guarded = async_with_langchain_guard(search, client, agent="bot")
        result = await guarded(query="hi")
        assert result == "async:hi"

    async def test_calls_async_protect(self) -> None:
        async def fn() -> str:
            return ""

        client = make_async_client()
        guarded = async_with_langchain_guard(fn, client, agent="svc:app")
        await guarded()
        client.protect.assert_awaited_once()

    async def test_annotates_async_dict_result(self) -> None:
        async def fetch() -> dict:
            return {"rows": [1, 2]}

        client = make_async_client()
        guarded = async_with_langchain_guard(fetch, client, agent="bot")
        result = await guarded()

        assert result["rows"] == [1, 2]
        assert result["_atlasent_permit_id"] == "dec_alpha"

    async def test_raises_on_async_deny(self) -> None:
        async def fn() -> str:
            return ""

        client = make_async_client(raise_exc=_denied_error())
        guarded = async_with_langchain_guard(fn, client, agent="bot")
        with pytest.raises(AtlaSentDeniedError):
            await guarded()

    async def test_returns_denial_result_async(self) -> None:
        async def fn() -> str:
            return ""

        client = make_async_client(raise_exc=_denied_error())
        guarded = async_with_langchain_guard(
            fn, client, agent="bot", on_deny="tool-result"
        )
        result = await guarded()

        assert isinstance(result, DenialResult)
        assert result.denied is True

    async def test_surfaces_async_transport_errors(self) -> None:
        async def fn() -> str:
            return ""

        client = make_async_client(raise_exc=OSError("net down"))
        guarded = async_with_langchain_guard(
            fn, client, agent="bot", on_deny="tool-result"
        )
        result = await guarded()

        assert isinstance(result, DenialResult)
        assert "net down" in result.reason
