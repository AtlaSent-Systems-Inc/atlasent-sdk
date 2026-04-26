"""Tests for ``with_otel`` / ``with_async_otel`` / ``with_otel_protect``.

Strategy: a real ``TracerProvider`` with an ``InMemorySpanExporter``
from ``opentelemetry-sdk``. Lets us assert span name, attributes,
status, and recorded exceptions exactly the way customer apps will
inspect spans in production exporters.

Mirrors ``typescript/packages/otel/test/withOtel.test.ts`` scenario-
for-scenario.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from unittest.mock import MagicMock

import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)
from opentelemetry.trace import StatusCode

from atlasent_otel_preview import (
    with_async_otel,
    with_otel,
    with_otel_protect,
)

# ── Tracer fixture ───────────────────────────────────────────────────


@pytest.fixture
def exporter():
    """Return (provider, exporter, tracer) wired with an in-memory exporter."""
    exp = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exp))
    # Don't override the global tracer provider — many tests can run
    # in parallel; pass the tracer explicitly via with_otel(...).
    yield provider, exp
    exp.clear()
    provider.shutdown()


def tracer_for(provider) -> trace.Tracer:
    return provider.get_tracer("test")


# ── Fake clients ─────────────────────────────────────────────────────


@dataclass
class FakeEvaluateResult:
    permit_token: str = "dec_abc"
    audit_hash: str = "h" * 64
    timestamp: str = "t"


@dataclass
class FakeVerifyResult:
    valid: bool = True
    permit_hash: str = "ph"


@dataclass
class FakeKeySelfResult:
    key_id: str = "k1"
    organization_id: str = "org-1"
    environment: str = "live"


@dataclass
class FakeAuditEventsResult:
    events: list[Any]
    total: int = 0


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

    def __init__(self, message: str, code: str, request_id: str = "req_1"):
        super().__init__(message)
        self.code = code
        self.request_id = request_id


# ── evaluate ─────────────────────────────────────────────────────────


class TestEvaluate:
    def test_creates_span_with_pre_call_attrs(self, exporter):
        provider, exp = exporter
        client = MagicMock()
        client.evaluate.return_value = FakeEvaluateResult()
        wrapped = with_otel(client, tracer_for(provider))

        wrapped.evaluate("deploy", "deploy-bot", {"commit": "abc"})

        spans = exp.get_finished_spans()
        assert len(spans) == 1
        span = spans[0]
        assert span.name == "atlasent.evaluate"
        assert span.attributes["atlasent.action"] == "deploy"
        assert span.attributes["atlasent.agent"] == "deploy-bot"
        assert span.attributes["atlasent.permit_token"] == "dec_abc"
        assert span.attributes["atlasent.audit_hash"] == "h" * 64
        assert span.status.status_code == StatusCode.OK

    def test_records_error_on_throw(self, exporter):
        provider, exp = exporter
        client = MagicMock()
        client.evaluate.side_effect = FakeError("rate limited", "rate_limited")
        wrapped = with_otel(client, tracer_for(provider))

        with pytest.raises(FakeError):
            wrapped.evaluate("deploy", "deploy-bot")

        span = exp.get_finished_spans()[0]
        assert span.status.status_code == StatusCode.ERROR
        assert "rate limited" in (span.status.description or "")
        assert span.attributes["atlasent.error_code"] == "rate_limited"
        assert span.attributes["atlasent.request_id"] == "req_1"
        # record_exception adds an exception event.
        assert any(e.name == "exception" for e in span.events)


# ── verify ───────────────────────────────────────────────────────────


class TestVerify:
    def test_creates_span_with_permit_token(self, exporter):
        provider, exp = exporter
        client = MagicMock()
        client.verify.return_value = FakeVerifyResult(valid=True)
        wrapped = with_otel(client, tracer_for(provider))

        wrapped.verify("dec_abc")

        span = exp.get_finished_spans()[0]
        assert span.name == "atlasent.verify_permit"
        assert span.attributes["atlasent.permit_token"] == "dec_abc"
        assert span.attributes["atlasent.verified"] is True
        assert span.status.status_code == StatusCode.OK

    def test_records_false_verification_status_ok(self, exporter):
        provider, exp = exporter
        client = MagicMock()
        client.verify.return_value = FakeVerifyResult(valid=False)
        wrapped = with_otel(client, tracer_for(provider))

        wrapped.verify("dec_abc")

        span = exp.get_finished_spans()[0]
        assert span.attributes["atlasent.verified"] is False
        assert span.status.status_code == StatusCode.OK


# ── protect ──────────────────────────────────────────────────────────


class TestProtect:
    def test_creates_span_with_permit_id(self, exporter):
        provider, exp = exporter
        client = MagicMock()
        client.protect.return_value = FakePermit()
        wrapped = with_otel(client, tracer_for(provider))

        wrapped.protect(agent="deploy-bot", action="deploy")

        span = exp.get_finished_spans()[0]
        assert span.name == "atlasent.protect"
        assert span.attributes["atlasent.agent"] == "deploy-bot"
        assert span.attributes["atlasent.action"] == "deploy"
        assert span.attributes["atlasent.permit_id"] == "permit-1"


# ── authorize ────────────────────────────────────────────────────────


class TestAuthorize:
    def test_creates_span_with_permitted_flag(self, exporter):
        provider, exp = exporter
        client = MagicMock()
        client.authorize.return_value = FakeAuthorizationResult()
        wrapped = with_otel(client, tracer_for(provider))

        wrapped.authorize(agent="deploy-bot", action="deploy")

        span = exp.get_finished_spans()[0]
        assert span.name == "atlasent.authorize"
        assert span.attributes["atlasent.permitted"] is True
        assert span.attributes["atlasent.permit_token"] == "permit-1"


# ── gate ─────────────────────────────────────────────────────────────


class TestGate:
    def test_creates_span(self, exporter):
        provider, exp = exporter
        client = MagicMock()
        client.gate.return_value = MagicMock()
        wrapped = with_otel(client, tracer_for(provider))

        wrapped.gate("read", "actor-1")

        span = exp.get_finished_spans()[0]
        assert span.name == "atlasent.gate"


# ── key_self ─────────────────────────────────────────────────────────


class TestKeySelf:
    def test_creates_span_with_key_id_and_environment(self, exporter):
        provider, exp = exporter
        client = MagicMock()
        client.key_self.return_value = FakeKeySelfResult()
        wrapped = with_otel(client, tracer_for(provider))

        wrapped.key_self()

        span = exp.get_finished_spans()[0]
        assert span.name == "atlasent.key_self"
        assert span.attributes["atlasent.key_id"] == "k1"
        assert span.attributes["atlasent.environment"] == "live"


# ── audit listing + export ──────────────────────────────────────────


class TestAuditMethods:
    def test_list_audit_events_records_event_count(self, exporter):
        provider, exp = exporter
        client = MagicMock()
        client.list_audit_events.return_value = FakeAuditEventsResult(
            events=[1, 2, 3], total=3
        )
        wrapped = with_otel(client, tracer_for(provider))

        wrapped.list_audit_events()

        span = exp.get_finished_spans()[0]
        assert span.name == "atlasent.list_audit_events"
        assert span.attributes["atlasent.event_count"] == 3

    def test_create_audit_export_records_export_id_and_count(self, exporter):
        provider, exp = exporter
        client = MagicMock()
        client.create_audit_export.return_value = FakeExportResult(events=[1])
        wrapped = with_otel(client, tracer_for(provider))

        wrapped.create_audit_export()

        span = exp.get_finished_spans()[0]
        assert span.name == "atlasent.create_audit_export"
        assert span.attributes["atlasent.export_id"] == "ex1"
        assert span.attributes["atlasent.event_count"] == 1


# ── Base attributes + prefix ─────────────────────────────────────────


class TestOptions:
    def test_merges_base_attributes(self, exporter):
        provider, exp = exporter
        client = MagicMock()
        client.evaluate.return_value = FakeEvaluateResult()
        wrapped = with_otel(
            client,
            tracer_for(provider),
            attributes={
                "service.name": "deploy-bot",
                "deployment.environment": "prod",
            },
        )

        wrapped.evaluate("deploy", "deploy-bot")

        span = exp.get_finished_spans()[0]
        assert span.attributes["service.name"] == "deploy-bot"
        assert span.attributes["deployment.environment"] == "prod"
        assert span.attributes["atlasent.action"] == "deploy"

    def test_respects_custom_span_name_prefix(self, exporter):
        provider, exp = exporter
        client = MagicMock()
        client.key_self.return_value = FakeKeySelfResult()
        wrapped = with_otel(
            client, tracer_for(provider), span_name_prefix="my-svc.atlasent."
        )

        wrapped.key_self()

        span = exp.get_finished_spans()[0]
        assert span.name == "my-svc.atlasent.key_self"


# ── with_otel_protect (top-level fn) ────────────────────────────────


class TestWithOtelProtect:
    def test_creates_span_with_agent_action(self, exporter):
        provider, exp = exporter

        def protect(*, agent, action, context=None):
            return FakePermit()

        wrapped = with_otel_protect(protect, tracer_for(provider))
        result = wrapped(agent="deploy-bot", action="deploy")

        assert result.permit_id == "permit-1"
        span = exp.get_finished_spans()[0]
        assert span.name == "atlasent.protect"
        assert span.attributes["atlasent.agent"] == "deploy-bot"
        assert span.attributes["atlasent.action"] == "deploy"
        assert span.attributes["atlasent.permit_id"] == "permit-1"

    def test_records_error_status_on_throw(self, exporter):
        provider, exp = exporter

        def protect(*, agent, action, context=None):
            raise RuntimeError("denied")

        wrapped = with_otel_protect(protect, tracer_for(provider))
        with pytest.raises(RuntimeError):
            wrapped(agent="a", action="b")

        span = exp.get_finished_spans()[0]
        assert span.status.status_code == StatusCode.ERROR

    def test_handles_non_object_returns(self, exporter):
        provider, exp = exporter

        def protect(*, agent, action, context=None):
            return None

        wrapped = with_otel_protect(protect, tracer_for(provider))
        wrapped(agent="a", action="b")

        span = exp.get_finished_spans()[0]
        assert "atlasent.permit_id" not in span.attributes


# ── with_async_otel (async client) ──────────────────────────────────


class TestAsync:
    async def test_async_evaluate_creates_span(self, exporter):
        provider, exp = exporter

        class AsyncClient:
            async def evaluate(self, action_type, actor_id, context=None):
                return FakeEvaluateResult()

        wrapped = with_async_otel(AsyncClient(), tracer_for(provider))
        await wrapped.evaluate("deploy", "deploy-bot")

        span = exp.get_finished_spans()[0]
        assert span.name == "atlasent.evaluate"
        assert span.attributes["atlasent.permit_token"] == "dec_abc"

    async def test_async_evaluate_records_error(self, exporter):
        provider, exp = exporter

        class AsyncClient:
            async def evaluate(self, action_type, actor_id, context=None):
                raise FakeError("denied", "forbidden")

        wrapped = with_async_otel(AsyncClient(), tracer_for(provider))
        with pytest.raises(FakeError):
            await wrapped.evaluate("a", "b")

        span = exp.get_finished_spans()[0]
        assert span.status.status_code == StatusCode.ERROR
        assert span.attributes["atlasent.error_code"] == "forbidden"

    async def test_async_protect(self, exporter):
        provider, exp = exporter

        class AsyncClient:
            async def protect(self, *, agent, action, context=None):
                return FakePermit()

        wrapped = with_async_otel(AsyncClient(), tracer_for(provider))
        await wrapped.protect(agent="deploy-bot", action="deploy")

        span = exp.get_finished_spans()[0]
        assert span.name == "atlasent.protect"
        assert span.attributes["atlasent.permit_id"] == "permit-1"

    async def test_async_verify(self, exporter):
        provider, exp = exporter

        class AsyncClient:
            async def verify(
                self, permit_token, action_type="", actor_id="", context=None
            ):
                return FakeVerifyResult(valid=True)

        wrapped = with_async_otel(AsyncClient(), tracer_for(provider))
        await wrapped.verify("dec_abc")

        span = exp.get_finished_spans()[0]
        assert span.name == "atlasent.verify_permit"
        assert span.attributes["atlasent.verified"] is True

    async def test_async_authorize(self, exporter):
        provider, exp = exporter

        class AsyncClient:
            async def authorize(self, *, agent, action, context=None):
                return FakeAuthorizationResult()

        wrapped = with_async_otel(AsyncClient(), tracer_for(provider))
        await wrapped.authorize(agent="a", action="b")

        span = exp.get_finished_spans()[0]
        assert span.name == "atlasent.authorize"
        assert span.attributes["atlasent.permitted"] is True

    async def test_async_key_self(self, exporter):
        provider, exp = exporter

        class AsyncClient:
            async def key_self(self):
                return FakeKeySelfResult()

        wrapped = with_async_otel(AsyncClient(), tracer_for(provider))
        await wrapped.key_self()

        span = exp.get_finished_spans()[0]
        assert span.attributes["atlasent.key_id"] == "k1"


# ── Misc shapes ─────────────────────────────────────────────────────


class TestMisc:
    def test_recorder_swallows_attribute_errors(self, exporter):
        """A broken-shape result shouldn't crash the call."""
        provider, exp = exporter
        client = MagicMock()
        # Return something with weird shape — getattr returns None,
        # the recorder should silently skip set_attribute.
        client.evaluate.return_value = object()
        wrapped = with_otel(client, tracer_for(provider))

        # No exception — call returns the (weird) value as-is.
        result = wrapped.evaluate("a", "b")
        assert result is not None

        span = exp.get_finished_spans()[0]
        # No permit_token attribute since result didn't have one.
        assert "atlasent.permit_token" not in span.attributes
        assert span.status.status_code == StatusCode.OK

    def test_recorder_robust_to_results_with_property_raises(self, exporter):
        """``getattr(obj, name, default)`` short-circuits AttributeError
        from a property access, so weird-shape results don't crash the
        recorder."""
        provider, exp = exporter
        client = MagicMock()

        class WeirdResult:
            @property
            def permit_token(self) -> str:
                raise AttributeError("oops")

            audit_hash = "h"

        client.evaluate.return_value = WeirdResult()
        wrapped = with_otel(client, tracer_for(provider))

        result = wrapped.evaluate("a", "b")
        assert isinstance(result, WeirdResult)
        span = exp.get_finished_spans()[0]
        # permit_token was effectively missing → not set; audit_hash was
        # a plain class attribute → set.
        assert "atlasent.permit_token" not in span.attributes
        assert span.attributes["atlasent.audit_hash"] == "h"
        assert span.status.status_code == StatusCode.OK
