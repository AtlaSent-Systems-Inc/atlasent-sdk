from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from atlasent_enforce import Enforce, RunRequest
from tests.sim.harness import bindings_from_fixture, build_mock_client, load_fixture

fx = load_fixture("SIM-06")


@pytest.mark.asyncio
@pytest.mark.parametrize("case", fx["cases"], ids=lambda c: c["label"])
async def test_latency_breach(case: dict) -> None:
    client = build_mock_client(fx)
    execute = AsyncMock(return_value="executed")
    warn_cb = MagicMock()
    enforce = Enforce(
        client=client,
        bindings=bindings_from_fixture(fx),
        fail_closed=True,
        latency_budget_ms=fx["enforce_config"]["latency_budget_ms"],
        latency_breach_mode=case["latency_breach_mode"],
        on_latency_breach=warn_cb,
    )

    result = await enforce.run(RunRequest(request=fx["request"], execute=execute))

    assert result.decision == case["expected"]["decision"]
    if case["expected"].get("reason_code"):
        assert result.reason_code == case["expected"]["reason_code"]
    if case["expected"]["execute_called"]:
        execute.assert_called_once()
    else:
        execute.assert_not_called()
    if case["expected"].get("warn_emitted"):
        warn_cb.assert_called_once()
