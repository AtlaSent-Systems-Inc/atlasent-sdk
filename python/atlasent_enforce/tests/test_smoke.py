from __future__ import annotations

import pytest

from atlasent_enforce import (
    Bindings,
    DisallowedConfigError,
    Enforce,
    EnforceCompatibleClient,
    EvaluateResponse,
    RunRequest,
    VerifiedPermit,
)


class _StubClient:
    async def evaluate(self, request: dict) -> EvaluateResponse:  # noqa: ARG002
        raise RuntimeError("stub")

    async def verify_permit(self, token: str) -> VerifiedPermit:  # noqa: ARG002
        raise RuntimeError("stub")


def _client() -> EnforceCompatibleClient:
    return _StubClient()  # type: ignore[return-value]


_BINDINGS = Bindings(org_id="org_test", actor_id="actor_test", action_type="deploy")


def test_constructs_with_fail_closed_true() -> None:
    enforce = Enforce(client=_client(), bindings=_BINDINGS, fail_closed=True)
    assert isinstance(enforce, Enforce)


def test_construction_rejects_fail_closed_false() -> None:
    with pytest.raises(DisallowedConfigError):
        Enforce(client=_client(), bindings=_BINDINGS, fail_closed=False)


async def test_run_raises_not_implemented_until_sim_lands() -> None:
    enforce = Enforce(client=_client(), bindings=_BINDINGS, fail_closed=True)
    request = RunRequest(
        request={},
        execute=lambda _permit: _unreachable(),  # type: ignore[arg-type]
    )
    with pytest.raises(NotImplementedError):
        await enforce.run(request)


async def _unreachable() -> str:
    raise AssertionError("execute must not run on a not-yet-implemented Enforce")
