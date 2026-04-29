"""Tests for ``with_sentry`` / ``with_async_sentry`` / ``with_sentry_protect``.

Strategy: monkey-patch ``sentry_sdk.add_breadcrumb`` and
``sentry_sdk.capture_exception`` so we capture every call without
needing to call ``sentry_sdk.init(...)``. Same approach as the TS
tests (``vi.mock`` of ``@sentry/core``).

Mirrors ``typescript/packages/sentry/test/withSentry.test.ts``
scenario-for-scenario.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from unittest.mock import MagicMock

import pytest
import sentry_sdk

from atlasent_sentry_preview import (
    with_async_sentry,
    with_sentry,
    with_sentry_protect,
)


@pytest.fixture
def captured(monkeypatch):
    """Patch sentry_sdk.add_breadcrumb + capture_exception, return them."""
    add = MagicMock()
    capture = MagicMock()
    monkeypatch.setattr(sentry_sdk, "add_breadcrumb", add)
    monkeypatch.setattr(sentry_sdk, "capture_exception", capture)
    return add, capture


def last_breadcrumb(add_mock):
    call = add_mock.call_args
    if call is None:
        raise AssertionError("no breadcrumb captured")
    return call.kwargs


# ── Fakes ────────────────────────────────────────────────────────────


@dataclass
class FakeEvaluateResult:
    permit_token: str = "dec_abc"
    audit_hash: str = "h" * 64


@dataclass
class FakeVerifyResult:
    valid: bool = True


@dataclass
class FakeKeySelfResult:
    key_id: str = "k1"
    environment: str = "live"


@dataclass
class FakeAuditEventsResult:
    events: list[Any]


@dataclass
class FakeExportResult:
    export_id: str = "ex1"
    events: list[Any] = None


@dataclass
class FakePermit:
    permit_id: str = "permit-1"
    audit_hash: str = "h"


@dataclass
class FakeAuthorizationResult:
    permitted: bool = True
    permit_token: str = "permit-1"


class FakeError(Exception):
    """Stand-in for AtlaSentError — has .code and .request_id."""

    def __init__(self, message: str, code: str, request_id: str = "req_42"):
        super().__init__(message)
        self.code = code
        self.request_id = request_id


# ── evaluate ─────────────────────────────────────────────────────────


class TestEvaluate:
    def test_emits_info_breadcrumb_with_decision(self, captured):
        add, capture = captured
        client = MagicMock()
        client.evaluate.return_value = FakeEvaluateResult()
        wrapped = with_sentry(client)

        wrapped.evaluate("deploy", "deploy-bot", {"commit": "abc"})

        bc = last_breadcrumb(add)
        assert bc["category"] == "atlasent"
        assert bc["message"] == "evaluate"
        assert bc["level"] == "info"
        assert bc["data"]["agent"] == "deploy-bot"
        assert bc["data"]["action"] == "deploy"
        assert bc["data"]["permit_token"] == "dec_abc"
        assert bc["data"]["audit_hash"] == "h" * 64

    def test_emits_error_breadcrumb_on_throw(self, captured):
        add, capture = captured
        client = MagicMock()
        client.evaluate.side_effect = FakeError("rate limited", "rate_limited")
        wrapped = with_sentry(client)

        with pytest.raises(FakeError):
            wrapped.evaluate("deploy", "deploy-bot")

        bc = last_breadcrumb(add)
        assert bc["level"] == "error"
        assert bc["data"]["error_code"] == "rate_limited"
        assert bc["data"]["request_id"] == "req_42"
        assert bc["data"]["error_message"] == "rate limited"
        # capture_errors defaulted to false → no exception capture.
        capture.assert_not_called()

    def test_capture_errors_true_calls_capture_exception(self, captured):
        add, capture = captured
        err = RuntimeError("boom")
        client = MagicMock()
        client.evaluate.side_effect = err
        wrapped = with_sentry(client, capture_errors=True)

        with pytest.raises(RuntimeError):
            wrapped.evaluate("a", "b")

        capture.assert_called_once_with(err)

    def test_extra_data_merges_onto_every_breadcrumb(self, captured):
        add, _ = captured
        client = MagicMock()
        client.evaluate.return_value = FakeEvaluateResult()
        wrapped = with_sentry(
            client,
            extra_data={"service": "deploy-bot", "tenant": "acme"},
        )

        wrapped.evaluate("deploy", "agent-1")

        bc = last_breadcrumb(add)
        assert bc["data"]["service"] == "deploy-bot"
        assert bc["data"]["tenant"] == "acme"
        assert bc["data"]["agent"] == "agent-1"


# ── verify ───────────────────────────────────────────────────────────


class TestVerify:
    def test_emits_breadcrumb_with_permit_token_and_verified(self, captured):
        add, _ = captured
        client = MagicMock()
        client.verify.return_value = FakeVerifyResult(valid=True)
        wrapped = with_sentry(client)

        wrapped.verify("dec_abc")

        bc = last_breadcrumb(add)
        assert bc["message"] == "verify_permit"
        assert bc["data"]["permit_token"] == "dec_abc"
        assert bc["data"]["verified"] is True

    def test_verified_false_stays_info_level(self, captured):
        add, _ = captured
        client = MagicMock()
        client.verify.return_value = FakeVerifyResult(valid=False)
        wrapped = with_sentry(client)

        wrapped.verify("dec_abc")

        bc = last_breadcrumb(add)
        # A failed verification is a valid result, not an SDK error.
        assert bc["level"] == "info"
        assert bc["data"]["verified"] is False


# ── protect / authorize / gate / key_self / audit ────────────────────


class TestProtect:
    def test_emits_breadcrumb_with_permit_id(self, captured):
        add, _ = captured
        client = MagicMock()
        client.protect.return_value = FakePermit()
        wrapped = with_sentry(client)

        wrapped.protect(agent="deploy-bot", action="deploy")

        bc = last_breadcrumb(add)
        assert bc["message"] == "protect"
        assert bc["data"]["permit_id"] == "permit-1"


class TestAuthorize:
    def test_emits_breadcrumb_with_permitted(self, captured):
        add, _ = captured
        client = MagicMock()
        client.authorize.return_value = FakeAuthorizationResult()
        wrapped = with_sentry(client)

        wrapped.authorize(agent="a", action="b")

        bc = last_breadcrumb(add)
        assert bc["message"] == "authorize"
        assert bc["data"]["permitted"] is True
        assert bc["data"]["permit_token"] == "permit-1"


class TestGate:
    def test_emits_breadcrumb(self, captured):
        add, _ = captured
        client = MagicMock()
        client.gate.return_value = MagicMock()
        wrapped = with_sentry(client)

        wrapped.gate("read", "actor-1")

        bc = last_breadcrumb(add)
        assert bc["message"] == "gate"


class TestKeySelf:
    def test_emits_breadcrumb_with_key_id_and_environment(self, captured):
        add, _ = captured
        client = MagicMock()
        client.key_self.return_value = FakeKeySelfResult()
        wrapped = with_sentry(client)

        wrapped.key_self()

        bc = last_breadcrumb(add)
        assert bc["message"] == "key_self"
        assert bc["data"]["key_id"] == "k1"
        assert bc["data"]["environment"] == "live"


class TestAuditMethods:
    def test_list_audit_events_records_event_count(self, captured):
        add, _ = captured
        client = MagicMock()
        client.list_audit_events.return_value = FakeAuditEventsResult(
            events=[1, 2, 3]
        )
        wrapped = with_sentry(client)

        wrapped.list_audit_events()

        bc = last_breadcrumb(add)
        assert bc["message"] == "list_audit_events"
        assert bc["data"]["event_count"] == 3

    def test_create_audit_export_records_export_id(self, captured):
        add, _ = captured
        client = MagicMock()
        client.create_audit_export.return_value = FakeExportResult(events=[1])
        wrapped = with_sentry(client)

        wrapped.create_audit_export()

        bc = last_breadcrumb(add)
        assert bc["message"] == "create_audit_export"
        assert bc["data"]["export_id"] == "ex1"
        assert bc["data"]["event_count"] == 1


# ── with_sentry_protect ─────────────────────────────────────────────


class TestWithSentryProtect:
    def test_emits_breadcrumb_with_permit_id(self, captured):
        add, _ = captured

        def protect(*, agent, action, context=None):
            return FakePermit()

        wrapped = with_sentry_protect(protect)
        result = wrapped(agent="deploy-bot", action="deploy")

        assert result.permit_id == "permit-1"
        bc = last_breadcrumb(add)
        assert bc["message"] == "protect"
        assert bc["data"]["agent"] == "deploy-bot"
        assert bc["data"]["permit_id"] == "permit-1"

    def test_capture_errors_true_calls_capture_exception(self, captured):
        add, capture = captured
        err = RuntimeError("denied")

        def protect(*, agent, action, context=None):
            raise err

        wrapped = with_sentry_protect(protect, capture_errors=True)
        with pytest.raises(RuntimeError):
            wrapped(agent="a", action="b")

        capture.assert_called_once_with(err)
        bc = last_breadcrumb(add)
        assert bc["level"] == "error"

    def test_handles_non_object_returns(self, captured):
        add, _ = captured

        def protect(*, agent, action, context=None):
            return None

        wrapped = with_sentry_protect(protect)
        wrapped(agent="a", action="b")

        bc = last_breadcrumb(add)
        # No permit_id field since result didn't have one.
        assert "permit_id" not in bc["data"]


# ── async wrapper ───────────────────────────────────────────────────


class TestAsync:
    async def test_async_evaluate(self, captured):
        add, _ = captured

        class AsyncClient:
            async def evaluate(self, action_type, actor_id, context=None):
                return FakeEvaluateResult()

        wrapped = with_async_sentry(AsyncClient())
        await wrapped.evaluate("deploy", "deploy-bot")

        bc = last_breadcrumb(add)
        assert bc["message"] == "evaluate"
        assert bc["data"]["permit_token"] == "dec_abc"

    async def test_async_evaluate_records_error(self, captured):
        add, capture = captured

        class AsyncClient:
            async def evaluate(self, action_type, actor_id, context=None):
                raise FakeError("denied", "forbidden")

        wrapped = with_async_sentry(AsyncClient(), capture_errors=True)
        with pytest.raises(FakeError):
            await wrapped.evaluate("a", "b")

        bc = last_breadcrumb(add)
        assert bc["level"] == "error"
        assert bc["data"]["error_code"] == "forbidden"
        capture.assert_called_once()

    async def test_async_protect(self, captured):
        add, _ = captured

        class AsyncClient:
            async def protect(self, *, agent, action, context=None):
                return FakePermit()

        wrapped = with_async_sentry(AsyncClient())
        await wrapped.protect(agent="deploy-bot", action="deploy")

        bc = last_breadcrumb(add)
        assert bc["data"]["permit_id"] == "permit-1"

    async def test_async_verify(self, captured):
        add, _ = captured

        class AsyncClient:
            async def verify(
                self, permit_token, action_type="", actor_id="", context=None
            ):
                return FakeVerifyResult(valid=True)

        wrapped = with_async_sentry(AsyncClient())
        await wrapped.verify("dec_abc")

        bc = last_breadcrumb(add)
        assert bc["data"]["verified"] is True

    async def test_async_authorize(self, captured):
        add, _ = captured

        class AsyncClient:
            async def authorize(self, *, agent, action, context=None):
                return FakeAuthorizationResult()

        wrapped = with_async_sentry(AsyncClient())
        await wrapped.authorize(agent="a", action="b")

        bc = last_breadcrumb(add)
        assert bc["data"]["permitted"] is True

    async def test_async_key_self(self, captured):
        add, _ = captured

        class AsyncClient:
            async def key_self(self):
                return FakeKeySelfResult()

        wrapped = with_async_sentry(AsyncClient())
        await wrapped.key_self()

        bc = last_breadcrumb(add)
        assert bc["data"]["key_id"] == "k1"


# ── error helper edge cases ────────────────────────────────────────


class TestErrorData:
    def test_non_atlasent_error_still_yields_breadcrumb(self, captured):
        add, _ = captured
        client = MagicMock()
        client.evaluate.side_effect = ValueError("plain error")
        wrapped = with_sentry(client)

        with pytest.raises(ValueError):
            wrapped.evaluate("a", "b")

        bc = last_breadcrumb(add)
        assert bc["level"] == "error"
        # error_message present even on plain Exception subclasses.
        assert bc["data"]["error_message"] == "plain error"
        # No error_code / request_id since the error doesn't carry them.
        assert "error_code" not in bc["data"]
        assert "request_id" not in bc["data"]
