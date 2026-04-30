"""Tests for atlasent_llamaindex guards."""
from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock

from atlasent.exceptions import AtlaSentDeniedError

from atlasent_llamaindex import (
    DenialResult,
    async_with_llamaindex_guard,
    with_llamaindex_guard,
)


# ── Fixtures ──────────────────────────────────────────────────────────────────

class _Permit:
    permit_id = "dec_alpha"
    permit_hash = "hash_permit"
    audit_hash = "hash_alpha"
    reason = "authorized"
    timestamp = "2026-04-30T10:00:00Z"


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


# ── with_llamaindex_guard (sync) ──────────────────────────────────────────────

class TestWithLlamaIndexGuard:
    def test_executes_func_and_returns_result(self) -> None:
        def search(query: str) -> str:
            return f"results:{query}"

        guarded = with_llamaindex_guard(search, make_sync_client(), agent="bot")
        assert guarded(query="hello") == "results:hello"

    def test_calls_protect_with_correct_args(self) -> None:
        def search(query: str) -> str:
            return ""

        client = make_sync_client()
        guarded = with_llamaindex_guard(search, client, agent="svc:app")
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
        guarded = with_llamaindex_guard(fn, client, agent="bot", action="vector_search")
        guarded()

        _, kwargs = client.protect.call_args
        assert kwargs["action"] == "vector_search"

    def test_annotates_dict_result(self) -> None:
        def fetch() -> dict:
            return {"nodes": ["a", "b"]}

        client = make_sync_client()
        result = with_llamaindex_guard(fetch, client, agent="bot")()

        assert result["nodes"] == ["a", "b"]
        assert result["_atlasent_permit_id"] == "dec_alpha"
        assert result["_atlasent_audit_hash"] == "hash_alpha"

    def test_passes_through_non_dict_result(self) -> None:
        def score() -> float:
            return 0.95

        guarded = with_llamaindex_guard(score, make_sync_client(), agent="bot")
        assert guarded() == pytest.approx(0.95)

    def test_passes_through_string_result(self) -> None:
        def retrieve(query: str) -> str:
            return f"retrieved:{query}"

        guarded = with_llamaindex_guard(retrieve, make_sync_client(), agent="bot")
        assert guarded(query="docs") == "retrieved:docs"

    def test_raises_on_deny_by_default(self) -> None:
        def fn() -> str:
            return ""

        guarded = with_llamaindex_guard(
            fn, make_sync_client(raise_exc=_denied_error()), agent="bot"
        )
        with pytest.raises(AtlaSentDeniedError):
            guarded()

    def test_returns_denial_result_when_on_deny_tool_result(self) -> None:
        def fn() -> str:
            return ""

        guarded = with_llamaindex_guard(
            fn, make_sync_client(raise_exc=_denied_error()), agent="bot",
            on_deny="tool-result",
        )
        result = guarded()

        assert isinstance(result, DenialResult)
        assert result.denied is True

    def test_surfaces_transport_errors_as_denial_result(self) -> None:
        def fn() -> str:
            return ""

        guarded = with_llamaindex_guard(
            fn, make_sync_client(raise_exc=TimeoutError("slow")), agent="bot",
            on_deny="tool-result",
        )
        result = guarded()

        assert isinstance(result, DenialResult)
        assert result.decision == "error"
        assert "slow" in result.reason

    def test_preserves_name_and_docstring(self) -> None:
        def vector_search(query: str) -> str:
            """Semantic search over the vector store."""
            return ""

        guarded = with_llamaindex_guard(vector_search, make_sync_client(), agent="bot")
        assert guarded.__name__ == "vector_search"
        assert guarded.__doc__ == "Semantic search over the vector store."

    def test_forwards_extra_context(self) -> None:
        def fn() -> str:
            return ""

        client = make_sync_client()
        guarded = with_llamaindex_guard(
            fn, client, agent="bot", extra_context={"index": "main"}
        )
        guarded()

        _, kwargs = client.protect.call_args
        assert kwargs["context"]["index"] == "main"


# ── async_with_llamaindex_guard ───────────────────────────────────────────────

class TestAsyncWithLlamaIndexGuard:
    async def test_executes_async_func(self) -> None:
        async def search(query: str) -> str:
            return f"async:{query}"

        guarded = async_with_llamaindex_guard(search, make_async_client(), agent="bot")
        assert await guarded(query="hi") == "async:hi"

    async def test_calls_async_protect(self) -> None:
        async def fn() -> str:
            return ""

        client = make_async_client()
        guarded = async_with_llamaindex_guard(fn, client, agent="svc:app")
        await guarded()
        client.protect.assert_awaited_once()

    async def test_annotates_async_dict_result(self) -> None:
        async def fetch() -> dict:
            return {"score": 0.9}

        client = make_async_client()
        result = await async_with_llamaindex_guard(fetch, client, agent="bot")()

        assert result["score"] == pytest.approx(0.9)
        assert result["_atlasent_permit_id"] == "dec_alpha"

    async def test_raises_on_async_deny(self) -> None:
        async def fn() -> str:
            return ""

        guarded = async_with_llamaindex_guard(
            fn, make_async_client(raise_exc=_denied_error()), agent="bot"
        )
        with pytest.raises(AtlaSentDeniedError):
            await guarded()

    async def test_returns_denial_result_async(self) -> None:
        async def fn() -> str:
            return ""

        guarded = async_with_llamaindex_guard(
            fn, make_async_client(raise_exc=_denied_error()), agent="bot",
            on_deny="tool-result",
        )
        result = await guarded()

        assert isinstance(result, DenialResult)
        assert result.denied is True

    async def test_surfaces_async_transport_errors(self) -> None:
        async def fn() -> str:
            return ""

        guarded = async_with_llamaindex_guard(
            fn, make_async_client(raise_exc=OSError("net down")), agent="bot",
            on_deny="tool-result",
        )
        result = await guarded()

        assert isinstance(result, DenialResult)
        assert "net down" in result.reason
