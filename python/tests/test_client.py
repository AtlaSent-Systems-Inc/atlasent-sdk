"""Unit tests for the sync AtlaSentClient using respx for HTTP mocking."""

from __future__ import annotations

import httpx
import pytest
import respx

from atlasent import (
    AtlaSentClient,
    EvaluateRequest,
    VerifyPermitRequest,
)
from atlasent.exceptions import (
    AuthorizationDeniedError,
    AuthorizationUnavailableError,
    PermitVerificationError,
    RateLimitError,
)

BASE_URL = "https://api.atlasent.test"


def _evaluate_body(**overrides):
    body = {
        "decision": "allow",
        "request_id": "r-1",
        "mode": "live",
        "cache_hit": False,
        "evaluation_ms": 5,
        "permit_token": "pt_abc",
        "expires_at": "2026-01-01T00:00:00Z",
    }
    body.update(overrides)
    return body


def _verify_body(**overrides):
    body = {"valid": True, "outcome": "allow", "decision": "allow", "reason": "ok"}
    body.update(overrides)
    return body


@pytest.fixture
def client() -> AtlaSentClient:
    return AtlaSentClient(api_key="ak_test", base_url=BASE_URL, max_retries=0)


class TestEvaluate:
    @respx.mock
    def test_allow_returns_full_response(self, client: AtlaSentClient) -> None:
        route = respx.post(f"{BASE_URL}/v1-evaluate").mock(
            return_value=httpx.Response(200, json=_evaluate_body())
        )
        res = client.evaluate(
            EvaluateRequest(action_type="payment.transfer", actor_id="user:1")
        )
        assert route.called
        assert res.decision == "allow"
        assert res.permit_token == "pt_abc"
        assert res.mode == "live"

    @respx.mock
    def test_deny_returns_response_without_raising(self, client: AtlaSentClient) -> None:
        respx.post(f"{BASE_URL}/v1-evaluate").mock(
            return_value=httpx.Response(
                200,
                json=_evaluate_body(
                    decision="deny",
                    permit_token=None,
                    deny_code="OVER_LIMIT",
                    deny_reason="no",
                ),
            )
        )
        res = client.evaluate(
            EvaluateRequest(action_type="payment.transfer", actor_id="user:1")
        )
        assert res.decision == "deny"
        assert res.permit_token is None
        assert res.deny_code == "OVER_LIMIT"

    @respx.mock
    def test_api_key_goes_in_header_not_body(self, client: AtlaSentClient) -> None:
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["auth"] = request.headers.get("authorization")
            captured["body"] = request.read().decode()
            return httpx.Response(200, json=_evaluate_body())

        respx.post(f"{BASE_URL}/v1-evaluate").mock(side_effect=handler)
        client.evaluate(EvaluateRequest(action_type="a", actor_id="u"))
        assert captured["auth"] == "Bearer ak_test"
        assert "api_key" not in captured["body"]

    @respx.mock
    def test_rate_limited_raises(self, client: AtlaSentClient) -> None:
        respx.post(f"{BASE_URL}/v1-evaluate").mock(
            return_value=httpx.Response(429, json={"error_code": "RATE_LIMITED", "reason": "slow down"})
        )
        with pytest.raises(RateLimitError):
            client.evaluate(EvaluateRequest(action_type="a", actor_id="u"))

    @respx.mock
    def test_auth_error_raises_unavailable(self, client: AtlaSentClient) -> None:
        respx.post(f"{BASE_URL}/v1-evaluate").mock(
            return_value=httpx.Response(
                401, json={"error_code": "UNAUTHORIZED", "reason": "bad key"}
            )
        )
        with pytest.raises(AuthorizationUnavailableError) as info:
            client.evaluate(EvaluateRequest(action_type="a", actor_id="u"))
        assert info.value.status_code == 401

    @respx.mock
    def test_malformed_response_raises_unavailable(
        self, client: AtlaSentClient
    ) -> None:
        respx.post(f"{BASE_URL}/v1-evaluate").mock(
            return_value=httpx.Response(200, json={"decision": "allow"})  # missing required fields
        )
        with pytest.raises(AuthorizationUnavailableError):
            client.evaluate(EvaluateRequest(action_type="a", actor_id="u"))


class TestAuthorize:
    @respx.mock
    def test_allow_returns_response(self, client: AtlaSentClient) -> None:
        respx.post(f"{BASE_URL}/v1-evaluate").mock(
            return_value=httpx.Response(200, json=_evaluate_body())
        )
        res = client.authorize(EvaluateRequest(action_type="a", actor_id="u"))
        assert res.decision == "allow"

    @respx.mock
    def test_deny_raises_with_response_accessors(self, client: AtlaSentClient) -> None:
        respx.post(f"{BASE_URL}/v1-evaluate").mock(
            return_value=httpx.Response(
                200,
                json=_evaluate_body(
                    decision="deny",
                    permit_token=None,
                    deny_code="OVER_LIMIT",
                    deny_reason="over",
                ),
            )
        )
        with pytest.raises(AuthorizationDeniedError) as info:
            client.authorize(EvaluateRequest(action_type="a", actor_id="u"))
        err = info.value
        assert err.decision == "deny"
        assert err.deny_code == "OVER_LIMIT"
        assert err.deny_reason == "over"
        assert err.request_id == "r-1"

    @respx.mock
    @pytest.mark.parametrize("decision", ["hold", "escalate"])
    def test_non_allow_raises(self, client: AtlaSentClient, decision: str) -> None:
        respx.post(f"{BASE_URL}/v1-evaluate").mock(
            return_value=httpx.Response(
                200, json=_evaluate_body(decision=decision, permit_token=None)
            )
        )
        with pytest.raises(AuthorizationDeniedError):
            client.authorize(EvaluateRequest(action_type="a", actor_id="u"))


class TestVerifyPermit:
    @respx.mock
    def test_valid_returns_envelope(self, client: AtlaSentClient) -> None:
        respx.post(f"{BASE_URL}/v1-verify-permit").mock(
            return_value=httpx.Response(200, json=_verify_body())
        )
        res = client.verify_permit(VerifyPermitRequest(permit_token="pt_x"))
        assert res.valid is True
        assert res.outcome == "allow"

    @respx.mock
    def test_invalid_200_is_value_based(self, client: AtlaSentClient) -> None:
        """Server returns 200 with valid:false -- do not raise, just surface the body."""
        respx.post(f"{BASE_URL}/v1-verify-permit").mock(
            return_value=httpx.Response(
                200,
                json={
                    "valid": False,
                    "outcome": "deny",
                    "verify_error_code": "PERMIT_ALREADY_USED",
                    "reason": "used",
                },
            )
        )
        res = client.verify_permit(VerifyPermitRequest(permit_token="pt_x"))
        assert res.valid is False
        assert res.verify_error_code == "PERMIT_ALREADY_USED"

    @respx.mock
    def test_invalid_4xx_is_still_value_based(self, client: AtlaSentClient) -> None:
        """Server may return 401/403/429 with the same value-based envelope."""
        respx.post(f"{BASE_URL}/v1-verify-permit").mock(
            return_value=httpx.Response(
                403,
                json={
                    "valid": False,
                    "outcome": "deny",
                    "verify_error_code": "INSUFFICIENT_SCOPE",
                    "reason": "no verify scope",
                },
            )
        )
        res = client.verify_permit(VerifyPermitRequest(permit_token="pt_x"))
        assert res.valid is False
        assert res.verify_error_code == "INSUFFICIENT_SCOPE"


class TestWithPermit:
    @respx.mock
    def test_allow_runs_fn_and_verifies(self, client: AtlaSentClient) -> None:
        respx.post(f"{BASE_URL}/v1-evaluate").mock(
            return_value=httpx.Response(200, json=_evaluate_body())
        )
        respx.post(f"{BASE_URL}/v1-verify-permit").mock(
            return_value=httpx.Response(200, json=_verify_body())
        )
        runs = {"n": 0}

        def fn(evaluation, verification):
            runs["n"] += 1
            assert verification.valid is True
            return "ran"

        out = client.with_permit(
            EvaluateRequest(action_type="a", actor_id="u"), fn
        )
        assert out == "ran"
        assert runs["n"] == 1

    @respx.mock
    def test_deny_prevents_fn(self, client: AtlaSentClient) -> None:
        respx.post(f"{BASE_URL}/v1-evaluate").mock(
            return_value=httpx.Response(
                200, json=_evaluate_body(decision="deny", permit_token=None)
            )
        )
        ran = {"ok": False}
        with pytest.raises(AuthorizationDeniedError):
            client.with_permit(
                EvaluateRequest(action_type="a", actor_id="u"),
                lambda e, v: ran.update(ok=True),
            )
        assert ran["ok"] is False

    @respx.mock
    def test_verify_denial_raises_permit_verification_error(
        self, client: AtlaSentClient
    ) -> None:
        respx.post(f"{BASE_URL}/v1-evaluate").mock(
            return_value=httpx.Response(200, json=_evaluate_body())
        )
        respx.post(f"{BASE_URL}/v1-verify-permit").mock(
            return_value=httpx.Response(
                200,
                json={
                    "valid": False,
                    "outcome": "deny",
                    "verify_error_code": "PERMIT_REVOKED",
                    "reason": "revoked",
                },
            )
        )
        ran = {"ok": False}
        with pytest.raises(PermitVerificationError) as info:
            client.with_permit(
                EvaluateRequest(action_type="a", actor_id="u"),
                lambda e, v: ran.update(ok=True),
            )
        assert info.value.verify_error_code == "PERMIT_REVOKED"
        assert ran["ok"] is False

    @respx.mock
    def test_binds_actor_and_action_type_on_verify(
        self, client: AtlaSentClient
    ) -> None:
        captured: dict = {}

        respx.post(f"{BASE_URL}/v1-evaluate").mock(
            return_value=httpx.Response(200, json=_evaluate_body())
        )

        def verify_handler(request: httpx.Request) -> httpx.Response:
            import json as _json

            captured["body"] = _json.loads(request.read().decode())
            return httpx.Response(200, json=_verify_body())

        respx.post(f"{BASE_URL}/v1-verify-permit").mock(side_effect=verify_handler)

        client.with_permit(
            EvaluateRequest(action_type="payment.transfer", actor_id="user:42"),
            lambda e, v: None,
        )
        assert captured["body"]["permit_token"] == "pt_abc"
        assert captured["body"]["actor_id"] == "user:42"
        assert captured["body"]["action_type"] == "payment.transfer"
