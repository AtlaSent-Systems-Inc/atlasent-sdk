"""Shared Python harness for SIM-01..SIM-10.

Loads a fixture JSON from contract/scenarios/ and builds mock clients whose
behaviour matches the fixture spec. Mirrors the TypeScript harness so drift
between languages is impossible — both consume the same JSON.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from atlasent_enforce.types import Bindings, EvaluateResponse, VerifiedPermit

SCENARIOS_DIR = Path(__file__).parents[4] / "contract" / "scenarios"


def load_fixture(sim_id: str) -> dict[str, Any]:
    return json.loads((SCENARIOS_DIR / f"{sim_id}.json").read_text())


# ── Error class used by mocks ─────────────────────────────────────────────────

class MockClientError(Exception):
    def __init__(self, http_status: int, reason_code: str | None) -> None:
        super().__init__(f"HTTP {http_status}" + (f": {reason_code}" if reason_code else ""))
        self.http_status = http_status
        self.reason_code = reason_code


# ── Evaluate mock ─────────────────────────────────────────────────────────────

def _build_evaluate(spec: dict[str, Any]):
    async def evaluate(_request: dict[str, Any]) -> EvaluateResponse:
        if spec["type"] == "http_error":
            raise MockClientError(spec["http_status"], spec.get("reason_code"))
        permit_stub = spec.get("permit")
        return EvaluateResponse(
            decision=spec["decision"],
            permit_token=permit_stub["token"] if permit_stub else None,
            permit_expires_at=permit_stub["expires_at"] if permit_stub else None,
            reason_code=spec.get("reason_code"),
        )

    return evaluate


# ── VerifyPermit mock ─────────────────────────────────────────────────────────

def _stub_to_verified(s: dict[str, Any]) -> VerifiedPermit:
    return VerifiedPermit(
        token=s["token"],
        org_id=s["org_id"],
        actor_id=s["actor_id"],
        action_type=s["action_type"],
        expires_at=s["expires_at"],
    )


def _build_single_verify(spec: dict[str, Any]):
    async def verify(_token: str) -> VerifiedPermit:
        if spec["type"] == "http_error":
            raise MockClientError(spec["http_status"], spec.get("reason_code"))
        if spec["type"] == "delayed":
            await asyncio.sleep(spec["delay_ms"] / 1000.0)
            return await _build_single_verify(spec["then"])(_token)
        return _stub_to_verified(spec["verified_permit"])

    return verify


# ── Mock client factory ───────────────────────────────────────────────────────

class MockClient:
    def __init__(
        self,
        evaluate_spec: dict[str, Any],
        verify_spec: dict[str, Any] | None,
        *,
        tamper_token: bool = False,
    ) -> None:
        self._evaluate_fn = _build_evaluate(evaluate_spec)
        self._verify_spec = verify_spec
        self._tamper_token = tamper_token
        self._verify_calls = 0
        self._sequence_index = 0

    async def evaluate(self, request: dict[str, Any]) -> EvaluateResponse:
        return await self._evaluate_fn(request)

    async def verify_permit(self, token: str) -> VerifiedPermit:
        self._verify_calls += 1
        spec = self._verify_spec
        if spec is None:
            raise AssertionError("verify_permit called unexpectedly")

        if spec["type"] in ("sequence", "concurrent_sequence"):
            responses = spec["responses"]
            idx = self._sequence_index
            self._sequence_index += 1
            resp = responses[idx] if idx < len(responses) else responses[-1]
            return await _build_single_verify(resp)(token)

        t = token + "X" if self._tamper_token else token
        return await _build_single_verify(spec)(t)

    @property
    def verify_calls(self) -> int:
        return self._verify_calls


def build_mock_client(
    fx: dict[str, Any],
    *,
    tamper_token: bool = False,
) -> MockClient:
    return MockClient(
        fx["mocks"]["evaluate"],
        fx["mocks"]["verify_permit"],
        tamper_token=tamper_token,
    )


def bindings_from_fixture(fx: dict[str, Any]) -> Bindings:
    b = fx["enforce_config"]["bindings"]
    return Bindings(org_id=b["org_id"], actor_id=b["actor_id"], action_type=b["action_type"])
