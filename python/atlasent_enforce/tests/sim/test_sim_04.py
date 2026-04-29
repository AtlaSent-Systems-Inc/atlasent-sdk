from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from atlasent_enforce import Enforce, RunRequest
from tests.sim.harness import bindings_from_fixture, build_mock_client, load_fixture

fx = load_fixture("SIM-04")
phases = fx["expected"]["phases"]


@pytest.mark.asyncio
async def test_replay_attempt() -> None:
    client = build_mock_client(fx)
    execute = AsyncMock(return_value="executed")
    enforce = Enforce(client=client, bindings=bindings_from_fixture(fx), fail_closed=True)

    # Phase 1 — first run
    r1 = await enforce.run(RunRequest(request=fx["request"], execute=execute))
    assert r1.decision == phases[0]["decision"]
    execute.assert_called_once()

    # Phase 2 — replay
    r2 = await enforce.run(RunRequest(request=fx["request"], execute=execute))
    assert r2.decision == phases[1]["decision"]
    assert r2.reason_code == phases[1]["reason_code"]
    execute.assert_called_once()  # still exactly once
