"""Tests for ``AtlaSentV2Client.consume`` and ``verify_proof``.

httpx is mocked via ``httpx.MockTransport`` so the client exercises the
full request/response cycle without touching the network.
"""

from __future__ import annotations

import json

import httpx
import pytest

from atlasent_v2_alpha import AtlaSentV2Client, V2Error
from atlasent_v2_alpha.types import ConsumeResponse, ProofVerificationResult


def _make_client(handler, *, api_key: str = "k") -> AtlaSentV2Client:
    transport = httpx.MockTransport(handler)
    inner = httpx.Client(transport=transport, base_url="https://example.test")
    inner.headers["Authorization"] = f"Bearer {api_key}"
    return AtlaSentV2Client(
        api_key=api_key, base_url="https://example.test", client=inner
    )


# ── Constructor ───────────────────────────────────────────────────────


class TestConstructor:
    def test_requires_api_key(self) -> None:
        with pytest.raises(V2Error) as exc:
            AtlaSentV2Client(api_key="")
        assert exc.value.code == "invalid_api_key"

    def test_strips_trailing_slash_from_base_url(self) -> None:
        captured: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            captured.append(str(request.url))
            return httpx.Response(
                200,
                json={
                    "proof_id": "11111111-1111-1111-1111-111111111111",
                    "execution_status": "executed",
                    "audit_hash": "a" * 64,
                },
            )

        transport = httpx.MockTransport(handler)
        inner = httpx.Client(transport=transport, base_url="https://example.test/api/")
        client = AtlaSentV2Client(
            api_key="k", base_url="https://example.test/api/", client=inner
        )
        client.consume(
            permit_id="p_1", payload_hash="f" * 64, execution_status="executed"
        )
        assert captured[0] == "https://example.test/api/v2/permits/p_1/consume"


# ── consume() ─────────────────────────────────────────────────────────


class TestConsume:
    def test_returns_consume_response_on_success(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "proof_id": "11111111-1111-1111-1111-111111111111",
                    "execution_status": "executed",
                    "audit_hash": "a" * 64,
                },
            )

        client = _make_client(handler)
        out = client.consume(
            permit_id="p_1", payload_hash="f" * 64, execution_status="executed"
        )
        assert isinstance(out, ConsumeResponse)
        assert out.proof_id == "11111111-1111-1111-1111-111111111111"
        assert out.execution_status == "executed"
        assert out.audit_hash == "a" * 64

    def test_sends_correct_body_with_api_key(self) -> None:
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["url"] = str(request.url)
            captured["method"] = request.method
            captured["body"] = json.loads(request.content.decode())
            captured["auth"] = request.headers.get("authorization")
            return httpx.Response(
                200,
                json={
                    "proof_id": "p",
                    "execution_status": "executed",
                    "audit_hash": "a" * 64,
                },
            )

        client = _make_client(handler, api_key="ask_live_xyz")
        client.consume(
            permit_id="permit_42",
            payload_hash="0" * 64,
            execution_status="executed",
            execution_hash="9" * 64,
        )
        assert captured["url"] == "https://example.test/v2/permits/permit_42/consume"
        assert captured["method"] == "POST"
        assert captured["body"] == {
            "permit_id": "permit_42",
            "payload_hash": "0" * 64,
            "execution_status": "executed",
            "execution_hash": "9" * 64,
            "api_key": "ask_live_xyz",
        }
        assert captured["auth"] == "Bearer ask_live_xyz"

    def test_omits_execution_hash_when_not_supplied(self) -> None:
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["body"] = json.loads(request.content.decode())
            return httpx.Response(
                200,
                json={
                    "proof_id": "p",
                    "execution_status": "failed",
                    "audit_hash": "a" * 64,
                },
            )

        client = _make_client(handler)
        client.consume(
            permit_id="p_1", payload_hash="f" * 64, execution_status="failed"
        )
        assert "execution_hash" not in captured["body"]

    def test_url_quotes_permit_id(self) -> None:
        captured: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            captured.append(str(request.url))
            return httpx.Response(
                200,
                json={
                    "proof_id": "p",
                    "execution_status": "executed",
                    "audit_hash": "a" * 64,
                },
            )

        client = _make_client(handler)
        client.consume(
            permit_id="permit/with/slash",
            payload_hash="f" * 64,
            execution_status="executed",
        )
        assert "permit%2Fwith%2Fslash" in captured[0]

    def test_401_raises_invalid_api_key(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(401, json={"error": "no"})

        client = _make_client(handler)
        with pytest.raises(V2Error) as exc:
            client.consume(
                permit_id="p", payload_hash="f" * 64, execution_status="executed"
            )
        assert exc.value.status_code == 401
        assert exc.value.code == "invalid_api_key"

    def test_500_raises_http_error(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(500, json={"error": "boom"})

        client = _make_client(handler)
        with pytest.raises(V2Error) as exc:
            client.consume(
                permit_id="p", payload_hash="f" * 64, execution_status="executed"
            )
        assert exc.value.status_code == 500
        assert exc.value.code == "http_error"
        assert exc.value.response_body == {"error": "boom"}

    def test_network_error_raises_network(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("refused")

        client = _make_client(handler)
        with pytest.raises(V2Error) as exc:
            client.consume(
                permit_id="p", payload_hash="f" * 64, execution_status="executed"
            )
        assert exc.value.code == "network"

    def test_timeout_raises_timeout(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            raise httpx.ReadTimeout("slow")

        client = _make_client(handler)
        with pytest.raises(V2Error) as exc:
            client.consume(
                permit_id="p", payload_hash="f" * 64, execution_status="executed"
            )
        assert exc.value.code == "timeout"

    def test_malformed_json_in_2xx_raises_bad_response(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200, content=b"{not-json", headers={"content-type": "application/json"}
            )

        client = _make_client(handler)
        with pytest.raises(V2Error) as exc:
            client.consume(
                permit_id="p", payload_hash="f" * 64, execution_status="executed"
            )
        assert exc.value.code == "bad_response"


# ── verify_proof() ────────────────────────────────────────────────────


class TestVerifyProof:
    def test_returns_proof_verification_result_on_success(self) -> None:
        expected = {
            "verification_status": "valid",
            "proof_id": "22222222-2222-2222-2222-222222222222",
            "checks": [
                {"name": "signature", "passed": True},
                {"name": "chain_link", "passed": True},
                {"name": "payload_hash", "passed": True},
                {"name": "policy_version", "passed": True},
                {"name": "execution_coherence", "passed": True},
            ],
        }

        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=expected)

        client = _make_client(handler)
        out = client.verify_proof("22222222-2222-2222-2222-222222222222")
        assert isinstance(out, ProofVerificationResult)
        assert out.verification_status == "valid"
        assert len(out.checks) == 5

    def test_posts_to_verify_endpoint_with_api_key_body(self) -> None:
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["url"] = str(request.url)
            captured["body"] = json.loads(request.content.decode())
            return httpx.Response(
                200,
                json={
                    "verification_status": "invalid",
                    "proof_id": "x",
                    "checks": [
                        {
                            "name": "signature",
                            "passed": False,
                            "reason": "invalid_signature",
                        }
                    ],
                },
            )

        client = _make_client(handler, api_key="ask_xyz")
        client.verify_proof("proof_42")
        assert captured["url"] == "https://example.test/v2/proofs/proof_42/verify"
        assert captured["body"] == {"api_key": "ask_xyz"}

    def test_surfaces_invalid_status_with_reason(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "verification_status": "invalid",
                    "proof_id": "p",
                    "checks": [
                        {
                            "name": "signature",
                            "passed": False,
                            "reason": "invalid_signature",
                        }
                    ],
                },
            )

        client = _make_client(handler)
        out = client.verify_proof("p")
        assert out.verification_status == "invalid"
        assert out.checks[0].passed is False
        assert out.checks[0].reason == "invalid_signature"

    def test_rejects_empty_proof_id_before_sending(self) -> None:
        sent = False

        def handler(_: httpx.Request) -> httpx.Response:
            nonlocal sent
            sent = True
            return httpx.Response(200)

        client = _make_client(handler)
        with pytest.raises(V2Error) as exc:
            client.verify_proof("")
        assert exc.value.code == "invalid_argument"
        assert sent is False


# ── Context-manager + close ───────────────────────────────────────────


class TestLifecycle:
    def test_close_closes_underlying_client(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "proof_id": "p",
                    "execution_status": "executed",
                    "audit_hash": "a" * 64,
                },
            )

        client = _make_client(handler)
        client.close()
        # Subsequent calls should fail because the inner client is closed.
        with pytest.raises(Exception):
            client.consume(
                permit_id="p", payload_hash="f" * 64, execution_status="executed"
            )

    def test_used_as_context_manager(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "proof_id": "p",
                    "execution_status": "executed",
                    "audit_hash": "a" * 64,
                },
            )

        with _make_client(handler) as client:
            out = client.consume(
                permit_id="p_1", payload_hash="f" * 64, execution_status="executed"
            )
            assert out.proof_id == "p"
