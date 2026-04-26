"""Tests for ``evaluate_batch_polyfilled`` /
``evaluate_batch_polyfilled_async``.

Sync path: hand-rolled fake client whose ``authorize`` returns
pre-canned :class:`AuthorizationResult`-shaped objects.
Async path: same fake exposed as an async method.

Mirrors ``typescript/packages/v2-preview/test/evaluateBatchPolyfill.test.ts``
scenario-for-scenario, plus the async-specific concurrency-cap path.
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from typing import Any

import pytest

from atlasent_v2_preview import (
    BatchEvaluateAllowItem,
    BatchEvaluateDenyItem,
    evaluate_batch_polyfilled,
    evaluate_batch_polyfilled_async,
)


@dataclass
class FakeAuthorizationResult:
    """Subset of v1's AuthorizationResult that the polyfill reads."""

    permitted: bool = True
    permit_token: str = "dec_alpha"
    audit_hash: str = "a" * 64
    reason: str = "ok"
    timestamp: str = "2026-04-25T00:00:00Z"


class _SyncFake:
    """Hand-rolled fake — tracks every call + records concurrency."""

    def __init__(self, responder):
        self._responder = responder
        self.calls = 0

    def authorize(
        self,
        *,
        agent: str,
        action: str,
        context=None,
        verify: bool = True,
        raise_on_deny: bool = False,
    ) -> Any:
        idx = self.calls
        self.calls += 1
        return self._responder(
            {"agent": agent, "action": action, "context": context}, idx
        )


class _AsyncFake:
    def __init__(self, responder):
        self._responder = responder
        self.calls = 0
        self.in_flight = 0
        self.max_in_flight = 0

    async def authorize(
        self,
        *,
        agent: str,
        action: str,
        context=None,
        verify: bool = True,
        raise_on_deny: bool = False,
    ) -> Any:
        idx = self.calls
        self.calls += 1
        self.in_flight += 1
        if self.in_flight > self.max_in_flight:
            self.max_in_flight = self.in_flight
        try:
            result = self._responder(
                {"agent": agent, "action": action, "context": context}, idx
            )
            if asyncio.iscoroutine(result):
                return await result
            return result
        finally:
            self.in_flight -= 1


ITEM = {"action": "modify_record", "agent": "agent-1", "context": {"id": "PT-001"}}


# ── Sync path ───────────────────────────────────────────────────────


class TestSyncHappyPath:
    def test_returns_v2_response_shape(self):
        client = _SyncFake(lambda _input, _idx: FakeAuthorizationResult())
        result = evaluate_batch_polyfilled(
            client, [ITEM], batch_id="fixed-batch-id"
        )
        assert result.batch_id == "fixed-batch-id"
        assert len(result.items) == 1
        item = result.items[0]
        assert isinstance(item, BatchEvaluateAllowItem)
        assert item.permitted is True
        assert item.index == 0
        assert item.decision_id == "dec_alpha"
        assert item.audit_hash == "a" * 64
        assert item.batch_id == "fixed-batch-id"

    def test_preserves_input_order_with_mixed_allow_deny(self):
        items = [
            {**ITEM, "context": {"id": "0"}},
            {**ITEM, "context": {"id": "1"}},
            {**ITEM, "context": {"id": "2"}},
        ]

        def respond(input, _idx):
            id_ = input["context"]["id"]
            return FakeAuthorizationResult(
                permitted=(id_ != "1"),
                permit_token=f"dec_{id_}",
                reason="missing change_reason" if id_ == "1" else "ok",
                audit_hash=id_ * 64,
            )

        client = _SyncFake(respond)
        result = evaluate_batch_polyfilled(client, items, batch_id="b")

        assert [item.permitted for item in result.items] == [True, False, True]
        assert [item.index for item in result.items] == [0, 1, 2]
        assert [item.decision_id for item in result.items] == [
            "dec_0",
            "dec_1",
            "dec_2",
        ]
        # Deny item has the deny shape.
        assert isinstance(result.items[1], BatchEvaluateDenyItem)

    def test_generates_uuid_batch_id_when_not_provided(self):
        client = _SyncFake(lambda _input, _idx: FakeAuthorizationResult())
        a = evaluate_batch_polyfilled(client, [ITEM])
        b = evaluate_batch_polyfilled(client, [ITEM])
        assert a.batch_id != b.batch_id
        # UUID v4 format.
        assert re.match(
            r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
            a.batch_id,
        )

    def test_calls_authorize_with_verify_false(self):
        recorded = []

        def respond(input, _idx):
            recorded.append(input)
            return FakeAuthorizationResult()

        client = _SyncFake(respond)
        # Wrap to capture the verify arg too.
        original_authorize = client.authorize

        def authorize_wrapper(**kwargs):
            recorded.append({"verify": kwargs.get("verify")})
            return original_authorize(**kwargs)

        client.authorize = authorize_wrapper  # type: ignore[method-assign]

        evaluate_batch_polyfilled(client, [ITEM])
        # The verify flag should have been passed as False so we don't
        # double up on round trips.
        assert any(r.get("verify") is False for r in recorded)


# ── Async path ──────────────────────────────────────────────────────


class TestAsyncHappyPath:
    async def test_returns_v2_response_shape(self):
        client = _AsyncFake(lambda _input, _idx: FakeAuthorizationResult())
        result = await evaluate_batch_polyfilled_async(
            client, [ITEM], batch_id="fixed-batch-id"
        )
        assert result.batch_id == "fixed-batch-id"
        assert len(result.items) == 1
        assert result.items[0].decision_id == "dec_alpha"

    async def test_preserves_input_order_with_mixed_allow_deny(self):
        items = [
            {**ITEM, "context": {"id": "0"}},
            {**ITEM, "context": {"id": "1"}},
            {**ITEM, "context": {"id": "2"}},
        ]

        def respond(input, _idx):
            id_ = input["context"]["id"]
            return FakeAuthorizationResult(
                permitted=(id_ != "1"),
                permit_token=f"dec_{id_}",
            )

        client = _AsyncFake(respond)
        result = await evaluate_batch_polyfilled_async(
            client, items, batch_id="b"
        )

        assert [item.permitted for item in result.items] == [True, False, True]
        assert [item.decision_id for item in result.items] == [
            "dec_0",
            "dec_1",
            "dec_2",
        ]


# ── Concurrency cap (async only) ────────────────────────────────────


class TestAsyncConcurrencyCap:
    async def test_default_is_capped_at_10(self):
        items = [{**ITEM, "context": {"id": str(i)}} for i in range(50)]

        async def slow(_input, _idx):
            await asyncio.sleep(0.001)
            return FakeAuthorizationResult()

        client = _AsyncFake(slow)
        await evaluate_batch_polyfilled_async(client, items)

        assert client.calls == 50
        assert client.max_in_flight <= 10

    async def test_respects_custom_concurrency(self):
        items = [ITEM] * 20

        async def slow(_input, _idx):
            await asyncio.sleep(0.001)
            return FakeAuthorizationResult()

        client = _AsyncFake(slow)
        await evaluate_batch_polyfilled_async(client, items, concurrency=3)

        assert client.max_in_flight <= 3

    async def test_unbounded_when_concurrency_is_none(self):
        items = [ITEM] * 5

        async def slow(_input, _idx):
            await asyncio.sleep(0.001)
            return FakeAuthorizationResult()

        client = _AsyncFake(slow)
        await evaluate_batch_polyfilled_async(client, items, concurrency=None)

        # Without a cap all 5 may run together.
        assert client.max_in_flight == 5


# ── Validation reuse ────────────────────────────────────────────────


class TestValidation:
    def test_rejects_empty_items(self):
        client = _SyncFake(lambda _input, _idx: FakeAuthorizationResult())
        with pytest.raises(ValueError, match="at least 1 item"):
            evaluate_batch_polyfilled(client, [])

    def test_rejects_more_than_1000_items(self):
        client = _SyncFake(lambda _input, _idx: FakeAuthorizationResult())
        with pytest.raises(ValueError, match="exceeds max 1000"):
            evaluate_batch_polyfilled(client, [ITEM] * 1001)

    def test_rejects_items_with_empty_action(self):
        client = _SyncFake(lambda _input, _idx: FakeAuthorizationResult())
        with pytest.raises(ValueError, match="items\\[0\\]"):
            evaluate_batch_polyfilled(client, [{**ITEM, "action": ""}])


# ── Error propagation ──────────────────────────────────────────────


class TestErrorPropagation:
    def test_sync_propagates_transport_errors(self):
        items = [ITEM] * 5

        def respond(_input, idx):
            if idx == 2:
                raise RuntimeError("network error")
            return FakeAuthorizationResult()

        client = _SyncFake(respond)
        with pytest.raises(RuntimeError, match="network error"):
            evaluate_batch_polyfilled(client, items)

    async def test_async_propagates_transport_errors(self):
        items = [ITEM] * 5

        def respond(_input, idx):
            if idx == 2:
                raise RuntimeError("async network error")
            return FakeAuthorizationResult()

        client = _AsyncFake(respond)
        with pytest.raises(RuntimeError, match="async network error"):
            await evaluate_batch_polyfilled_async(client, items)

    def test_sync_clean_deny_becomes_permitted_false_not_error(self):
        client = _SyncFake(
            lambda _input, _idx: FakeAuthorizationResult(
                permitted=False,
                permit_token="dec_x",
                reason="policy denied",
                audit_hash="h",
            )
        )
        result = evaluate_batch_polyfilled(client, [ITEM])
        assert result.items[0].permitted is False
        assert isinstance(result.items[0], BatchEvaluateDenyItem)
        assert result.items[0].reason == "policy denied"


# ── 1000-item boundary ──────────────────────────────────────────────


class Test1000ItemBoundary:
    def test_sync_accepts_1000_items(self):
        items = [ITEM] * 1000
        client = _SyncFake(lambda _input, _idx: FakeAuthorizationResult())
        result = evaluate_batch_polyfilled(client, items)
        assert len(result.items) == 1000

    async def test_async_accepts_1000_items(self):
        items = [ITEM] * 1000
        client = _AsyncFake(lambda _input, _idx: FakeAuthorizationResult())
        result = await evaluate_batch_polyfilled_async(
            client, items, concurrency=50
        )
        assert len(result.items) == 1000
