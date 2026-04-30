from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from atlasent_enforce import Enforce, RunRequest
from tests.sim.harness import bindings_from_fixture, build_mock_client, load_fixture

fx = load_fixture("SIM-07")


@pytest.mark.asyncio
async def test_tampered_permit() -> None:
    client = build_mock_client(fx, tamper_token=True)
    execute = AsyncMock(return_value="unreachable")
    enforce = Enforce(
        client=client, bindings=bindings_from_fixture(fx), fail_closed=True
    )

    result = await enforce.run(RunRequest(request=fx["request"], execute=execute))

    assert result.decision == "deny"
    assert result.reason_code == "permit_tampered"
    execute.assert_not_called()
    assert client.verify_calls > 0
