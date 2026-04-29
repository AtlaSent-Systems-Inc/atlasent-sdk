from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from atlasent_enforce import Enforce
from tests.sim.harness import bindings_from_fixture, build_mock_client, load_fixture

fx = load_fixture("SIM-01")


@pytest.mark.asyncio
async def test_no_permit_deny() -> None:
    client = build_mock_client(fx)
    execute = AsyncMock(return_value="unreachable")
    enforce = Enforce(client=client, bindings=bindings_from_fixture(fx), fail_closed=True)

    result = await enforce.run(
        __import__("atlasent_enforce").RunRequest(request=fx["request"], execute=execute)
    )

    assert result.decision == fx["expected"]["decision"]
    assert result.reason_code == fx["expected"]["reason_code"]
    execute.assert_not_called()
    assert client.verify_calls == 0
