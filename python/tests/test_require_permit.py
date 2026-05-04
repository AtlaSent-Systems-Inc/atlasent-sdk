"""Tests for require_permit, ProtectedAction, and classify_command."""

from __future__ import annotations

from typing import TypeVar

import pytest

import sys

import atlasent.require_permit  # noqa: F401  (ensure submodule registered in sys.modules)
from atlasent.require_permit import ProtectedAction, classify_command, require_permit

# The package re-exports the `require_permit` function under the same name as
# the submodule, which shadows attribute access. Resolve the submodule via
# sys.modules so monkeypatch can target it.
_require_permit_module = sys.modules["atlasent.require_permit"]

_T = TypeVar("_T")

# ---------------------------------------------------------------------------
# classify_command
# ---------------------------------------------------------------------------

DESTRUCTIVE_CASES = [
    "rm -rf /data",
    "DROP TABLE users",
    "drop table sessions",
    "DROP DATABASE analytics",
    "DELETE FROM logs",
    "TRUNCATE TABLE temp_events",
    "railway volume delete vol-abc",
    "kubectl delete pod my-pod",
    "terraform destroy -auto-approve",
]

SAFE_CASES = [
    "ls -la",
    "SELECT * FROM users",
    "INSERT INTO events VALUES (?)",
    "UPDATE users SET name = ?",
    "git status",
    "npm install",
    "docker ps",
    "echo hello",
    "cat file.txt",
]


@pytest.mark.parametrize("cmd", DESTRUCTIVE_CASES)
def test_classify_command_destructive(cmd: str) -> None:
    assert classify_command(cmd) == "destructive.command"


@pytest.mark.parametrize("cmd", SAFE_CASES)
def test_classify_command_safe(cmd: str) -> None:
    assert classify_command(cmd) is None


# ---------------------------------------------------------------------------
# require_permit
# ---------------------------------------------------------------------------


def _action(**overrides: object) -> ProtectedAction:
    base: dict[str, object] = {
        "action_type": "db.table.delete",
        "actor_id": "test-agent",
        "resource_id": "users",
        "environment": "development",
        "context": {},
    }
    base.update(overrides)
    return ProtectedAction(**base)  # type: ignore[arg-type]


async def _resolve(value: _T) -> _T:
    return value


@pytest.mark.asyncio
async def test_require_permit_allow_runs_executor(monkeypatch: pytest.MonkeyPatch) -> None:
    """When protect() resolves, the executor runs and its return value is propagated."""
    monkeypatch.setattr(
        _require_permit_module,
        "protect",
        lambda **_: _resolve(None),
    )

    sentinel = object()
    result = await require_permit(_action(), lambda: _resolve(sentinel))
    assert result is sentinel


@pytest.mark.asyncio
async def test_require_permit_deny_never_calls_executor(monkeypatch: pytest.MonkeyPatch) -> None:
    """When protect() raises AtlaSentDeniedError, the executor must NOT be called."""
    from atlasent.exceptions import AtlaSentDeniedError

    called = False

    async def _raise(**_: object) -> None:
        raise AtlaSentDeniedError(evaluation_id="evt-1", reason="denied")

    monkeypatch.setattr(_require_permit_module, "protect", _raise)

    async def _executor() -> None:
        nonlocal called
        called = True

    with pytest.raises(AtlaSentDeniedError):
        await require_permit(_action(), _executor)

    assert not called


@pytest.mark.asyncio
async def test_require_permit_transport_error_never_calls_executor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Any protect() exception prevents the executor from running."""
    from atlasent.exceptions import AtlaSentError

    called = False

    async def _raise(**_: object) -> None:
        raise AtlaSentError("network down")

    monkeypatch.setattr(_require_permit_module, "protect", _raise)

    async def _executor() -> None:
        nonlocal called
        called = True

    with pytest.raises(AtlaSentError):
        await require_permit(_action(), _executor)

    assert not called


@pytest.mark.asyncio
async def test_require_permit_context_forwarding(monkeypatch: pytest.MonkeyPatch) -> None:
    """resource_id, environment, and custom context keys must reach protect()."""
    captured: dict[str, object] = {}

    async def _capture(**kwargs: object) -> None:
        captured.update(kwargs)

    monkeypatch.setattr(_require_permit_module, "protect", _capture)

    await require_permit(
        _action(
            resource_id="payments",
            environment="production",
            context={"reason": "GDPR #999"},
        ),
        lambda: _resolve(None),
    )

    ctx = captured.get("context", {})
    assert isinstance(ctx, dict)
    assert ctx["resource_id"] == "payments"
    assert ctx["environment"] == "production"
    assert ctx["reason"] == "GDPR #999"


@pytest.mark.asyncio
async def test_require_permit_generic_return_type(monkeypatch: pytest.MonkeyPatch) -> None:
    """Return type follows the executor."""
    monkeypatch.setattr(
        _require_permit_module,
        "protect",
        lambda **_: _resolve(None),
    )

    assert await require_permit(_action(), lambda: _resolve(42)) == 42
    assert await require_permit(_action(), lambda: _resolve("ok")) == "ok"
    assert await require_permit(_action(), lambda: _resolve({"a": 1})) == {"a": 1}


def test_protected_action_is_frozen() -> None:
    """ProtectedAction must be immutable (frozen dataclass)."""
    pa = _action()
    with pytest.raises(Exception):
        pa.action_type = "mutated"  # type: ignore[misc]
