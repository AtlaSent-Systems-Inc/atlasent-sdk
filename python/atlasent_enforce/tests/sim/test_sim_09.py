from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest

from atlasent_enforce import Enforce, RunRequest
from tests.sim.harness import bindings_from_fixture, build_mock_client, load_fixture

fx = load_fixture("SIM-09")
exp = fx["expected"]


@pytest.mark.asyncio
async def test_concurrent_consume() -> None:
    # Both instances share the same mock client so the sequence counter is shared
    client = build_mock_client(fx)
    execute = AsyncMock(return_value="executed")

    def make_enforce() -> Enforce:
        return Enforce(
            client=client, bindings=bindings_from_fixture(fx), fail_closed=True
        )

    r1, r2 = await asyncio.gather(
        make_enforce().run(RunRequest(request=fx["request"], execute=execute)),
        make_enforce().run(RunRequest(request=fx["request"], execute=execute)),
    )

    decisions = [r1.decision, r2.decision]
    assert decisions.count("allow") == exp["allow_count"]
    assert decisions.count("deny") == exp["deny_count"]

    deny_result = next(r for r in [r1, r2] if r.decision == "deny")
    assert deny_result.reason_code == exp["deny_reason_code"]

    assert execute.call_count == exp["execute_call_count"]
