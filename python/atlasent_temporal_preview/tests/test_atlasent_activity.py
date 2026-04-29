"""Tests for ``atlasent_activity`` decorator.

Strategy: patch both peer-dep call points (``atlasent.protect`` and
``temporalio.activity.info``) at the import boundary inside the
decorator module so each test exercises the wrapper's resolver /
context-enrichment / call-order logic without standing up a real
Temporal worker or AtlaSent staging tenant.

Mirrors
``typescript/packages/temporal/test/withAtlaSentActivity.test.ts``
scenario-for-scenario.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from unittest.mock import MagicMock

import pytest

from atlasent_temporal_preview import atlasent_activity

# ── Test fixtures ────────────────────────────────────────────────────


@dataclass
class FakeActivityInfo:
    """Subset of ``temporalio.activity.Info`` the wrapper reads."""

    workflow_id: str = "wf-1"
    workflow_run_id: str = "run-abc"
    activity_id: str = "act-1"
    activity_type: str = "deployActivity"
    attempt: int = 1


@pytest.fixture
def patched(mocker):
    """Wire fakes for activity.info() and atlasent.protect().

    Returns a tuple (info_obj, protect_mock) that tests mutate to
    drive scenarios. The activity.info() patch is module-scoped to
    the decorator's import; protect is patched the same way.
    """
    info = FakeActivityInfo()
    mocker.patch(
        "atlasent_temporal_preview.atlasent_activity.activity.info",
        return_value=info,
    )
    protect_mock = MagicMock(
        return_value=type(
            "Permit",
            (),
            {
                "permit_id": "permit-1",
                "permit_hash": "hash-1",
                "audit_hash": "audit-1",
                "reason": "ok",
                "timestamp": "2026-04-25T00:00:00Z",
            },
        )()
    )
    mocker.patch(
        "atlasent_temporal_preview.atlasent_activity.atlasent_protect",
        protect_mock,
    )
    return info, protect_mock


# ── Call ordering + protect args ─────────────────────────────────────


class TestCallOrdering:
    async def test_calls_protect_before_activity_and_returns_result(self, patched):
        _, protect_mock = patched
        order: list[str] = []

        async def activity_fn(input: dict) -> str:
            order.append("activity")
            return f"deployed:{input['sha']}"

        def fake_protect(*args, **kwargs):
            order.append("protect")
            return None

        protect_mock.side_effect = fake_protect
        wrapped = atlasent_activity(action="deploy_to_production")(activity_fn)
        result = await wrapped({"sha": "abc"})

        assert result == "deployed:abc"
        assert order == ["protect", "activity"]
        assert protect_mock.call_count == 1

    async def test_string_action_passes_through(self, patched):
        _, protect_mock = patched

        async def activity_fn(_: Any) -> str:
            return "ok"

        wrapped = atlasent_activity(action="deploy")(activity_fn)
        await wrapped({})
        assert protect_mock.call_args.kwargs["action"] == "deploy"

    async def test_function_action_resolves_per_call(self, patched):
        _, protect_mock = patched

        async def activity_fn(_: Any) -> str:
            return "ok"

        wrapped = atlasent_activity(action=lambda i: f"do_{i['kind']}")(activity_fn)
        await wrapped({"kind": "deploy"})
        await wrapped({"kind": "rollback"})
        assert protect_mock.call_args_list[0].kwargs["action"] == "do_deploy"
        assert protect_mock.call_args_list[1].kwargs["action"] == "do_rollback"

    async def test_async_function_action_resolves(self, patched):
        _, protect_mock = patched

        async def activity_fn(_: Any) -> str:
            return "ok"

        async def async_action(input: dict) -> str:
            return f"async_{input['kind']}"

        wrapped = atlasent_activity(action=async_action)(activity_fn)
        await wrapped({"kind": "x"})
        assert protect_mock.call_args.kwargs["action"] == "async_x"


# ── Context resolution ──────────────────────────────────────────────


class TestContext:
    async def test_function_context_resolves_per_call(self, patched):
        _, protect_mock = patched

        async def activity_fn(_: Any) -> str:
            return "ok"

        wrapped = atlasent_activity(
            action="deploy",
            context_builder=lambda i: {"commit": i["sha"]},
        )(activity_fn)
        await wrapped({"sha": "abc"})
        assert protect_mock.call_args.kwargs["context"]["commit"] == "abc"

    async def test_merges_caller_context_with_temporal_metadata(self, patched):
        _, protect_mock = patched

        async def activity_fn(_: Any) -> str:
            return "ok"

        wrapped = atlasent_activity(
            action="deploy",
            context_builder=lambda _: {"commit": "abc", "env": "prod"},
        )(activity_fn)
        await wrapped({})

        ctx = protect_mock.call_args.kwargs["context"]
        assert ctx["commit"] == "abc"
        assert ctx["env"] == "prod"
        assert ctx["_atlasent_temporal"] == {
            "workflow_id": "wf-1",
            "run_id": "run-abc",
            "activity_id": "act-1",
            "activity_type": "deployActivity",
            "attempt": 1,
        }

    async def test_no_context_builder_uses_empty_dict(self, patched):
        _, protect_mock = patched

        async def activity_fn(_: Any) -> str:
            return "ok"

        wrapped = atlasent_activity(action="deploy")(activity_fn)
        await wrapped({})
        ctx = protect_mock.call_args.kwargs["context"]
        # Only the namespaced metadata is present.
        assert set(ctx.keys()) == {"_atlasent_temporal"}

    async def test_async_context_builder(self, patched):
        _, protect_mock = patched

        async def activity_fn(_: Any) -> str:
            return "ok"

        async def async_ctx(input: Any) -> dict:
            return {"async_field": input["value"]}

        wrapped = atlasent_activity(
            action="deploy", context_builder=async_ctx
        )(activity_fn)
        await wrapped({"value": 42})
        assert protect_mock.call_args.kwargs["context"]["async_field"] == 42


# ── Agent resolution ─────────────────────────────────────────────────


class TestAgent:
    async def test_default_agent_is_workflow_id_colon_activity_type(self, patched):
        info, protect_mock = patched
        info.workflow_id = "deploy-wf"
        info.activity_type = "rolloutActivity"

        async def activity_fn(_: Any) -> str:
            return "ok"

        wrapped = atlasent_activity(action="deploy")(activity_fn)
        await wrapped({})
        assert protect_mock.call_args.kwargs["agent"] == "deploy-wf:rolloutActivity"

    async def test_explicit_agent_literal(self, patched):
        _, protect_mock = patched

        async def activity_fn(_: Any) -> str:
            return "ok"

        wrapped = atlasent_activity(action="deploy", agent="deploy-bot")(activity_fn)
        await wrapped({})
        assert protect_mock.call_args.kwargs["agent"] == "deploy-bot"

    async def test_function_agent_resolver(self, patched):
        _, protect_mock = patched

        async def activity_fn(_: Any) -> str:
            return "ok"

        wrapped = atlasent_activity(
            action="deploy",
            agent=lambda i: f"user:{i['user']}",
        )(activity_fn)
        await wrapped({"user": "smith"})
        assert protect_mock.call_args.kwargs["agent"] == "user:smith"


# ── Workflow attempt threading ──────────────────────────────────────


class TestRetrySupport:
    async def test_attempt_appears_in_metadata(self, patched):
        info, protect_mock = patched
        info.attempt = 4

        async def activity_fn(_: Any) -> str:
            return "ok"

        wrapped = atlasent_activity(action="deploy")(activity_fn)
        await wrapped({})
        ctx = protect_mock.call_args.kwargs["context"]
        assert ctx["_atlasent_temporal"]["attempt"] == 4


# ── Error propagation ───────────────────────────────────────────────


class TestErrorPropagation:
    async def test_protect_failure_skips_activity(self, patched):
        _, protect_mock = patched

        called = False

        async def activity_fn(_: Any) -> str:
            nonlocal called
            called = True
            return "ok"

        def deny(*args, **kwargs):
            raise RuntimeError("policy denied")

        protect_mock.side_effect = deny
        wrapped = atlasent_activity(action="deploy")(activity_fn)

        with pytest.raises(RuntimeError, match="policy denied"):
            await wrapped({})
        assert called is False

    async def test_activity_failure_after_successful_protect(self, patched):
        _, protect_mock = patched

        async def activity_fn(_: Any) -> str:
            raise RuntimeError("activity blew up")

        wrapped = atlasent_activity(action="deploy")(activity_fn)
        with pytest.raises(RuntimeError, match="activity blew up"):
            await wrapped({})
        assert protect_mock.call_count == 1


# ── Type / signature preservation ───────────────────────────────────


class TestSignaturePreservation:
    async def test_preserves_input_and_output_types(self, patched):
        async def activity_fn(input: dict[str, int]) -> int:
            return input["count"] * 2

        wrapped = atlasent_activity(action="double")(activity_fn)
        out = await wrapped({"count": 21})
        assert out == 42

    async def test_preserves_function_name(self, patched):
        # functools.wraps copies __name__ + __doc__.
        async def deploy_activity(_: Any) -> str:
            """Run the deploy."""
            return "ok"

        wrapped = atlasent_activity(action="deploy")(deploy_activity)
        assert wrapped.__name__ == "deploy_activity"
        assert "Run the deploy" in (wrapped.__doc__ or "")


# ── _activity_input shapes (kwargs and multi-arg fallbacks) ─────────


class TestActivityInputShapes:
    async def test_keyword_only_input_uses_kwargs_dict(self, patched):
        _, protect_mock = patched

        async def activity_fn(*, sha: str) -> str:
            return f"deployed:{sha}"

        # Action resolver receives the kwargs dict.
        wrapped = atlasent_activity(
            action=lambda kw: f"do_{kw['sha']}"
        )(activity_fn)
        result = await wrapped(sha="abc")
        assert result == "deployed:abc"
        assert protect_mock.call_args.kwargs["action"] == "do_abc"

    async def test_multiple_positional_args(self, patched):
        _, protect_mock = patched

        async def activity_fn(a: str, b: str) -> str:
            return f"{a}-{b}"

        # Resolver receives {"args": (a, b), "kwargs": {}}.
        wrapped = atlasent_activity(
            action=lambda i: f"do_{i['args'][0]}"
        )(activity_fn)
        result = await wrapped("first", "second")
        assert result == "first-second"
        assert protect_mock.call_args.kwargs["action"] == "do_first"
