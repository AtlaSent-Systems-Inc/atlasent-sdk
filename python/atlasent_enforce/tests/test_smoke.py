from __future__ import annotations

import pytest

from atlasent_enforce import Bindings, DisallowedConfigError, Enforce
from tests.sim.harness import MockClient

_BINDINGS = Bindings(org_id="org_test", actor_id="actor_test", action_type="deploy")

# Minimal stub that never actually calls evaluate/verify
_stub_spec: dict = {"type": "http_error", "http_status": 500, "reason_code": None}
_stub_client = MockClient(_stub_spec, _stub_spec)


def test_constructs_with_fail_closed_true() -> None:
    assert isinstance(Enforce(client=_stub_client, bindings=_BINDINGS, fail_closed=True), Enforce)


def test_rejects_fail_closed_false() -> None:
    with pytest.raises(DisallowedConfigError):
        Enforce(client=_stub_client, bindings=_BINDINGS, fail_closed=False)
