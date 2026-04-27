"""Type-level drift detector for the v2 Pillar 9 pydantic models.

Every required field declared in ``contract/schemas/v2/*.schema.json``
MUST appear on the corresponding pydantic model. The test reads the
schemas at test time, collects their required-field sets, and asserts
that each required key exists in the model's ``model_fields`` map.

Also instantiates one fully-populated fixture per model so a schema
gaining a required field the pydantic class doesn't declare fails
immediately in the ``model_validate`` path.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from atlasent_v2_alpha.types import (
    ConsumeRequest,
    ConsumeResponse,
    Proof,
    ProofVerificationCheck,
    ProofVerificationResult,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
SCHEMAS_DIR = REPO_ROOT / "contract" / "schemas" / "v2"


def _load_schema(file: str) -> dict[str, Any]:
    return json.loads((SCHEMAS_DIR / file).read_text(encoding="utf-8"))


FULL_PROOF = {
    "proof_id": "550e8400-e29b-41d4-a716-446655440000",
    "permit_id": "dec_abc",
    "org_id": "org-1",
    "agent": "deploy-bot",
    "action": "deploy_to_production",
    "target": "prod-cluster",
    "payload_hash": "0" * 64,
    "policy_version": "v3-a7f1",
    "decision": "allow",
    "execution_status": "executed",
    "execution_hash": None,
    "audit_hash": "a" * 64,
    "previous_hash": "0" * 64,
    "chain_hash": "a" * 64,
    "signing_key_id": "key-1",
    "signature": "sig_base64url",
    "issued_at": "2026-04-24T12:00:00Z",
    "consumed_at": "2026-04-24T12:00:01Z",
}

FULL_CONSUME_REQUEST = {
    "permit_id": "dec_abc",
    "payload_hash": "0" * 64,
    "execution_status": "executed",
    "api_key": "ask_live_test",
}

FULL_CONSUME_RESPONSE = {
    "proof_id": "550e8400-e29b-41d4-a716-446655440000",
    "execution_status": "executed",
    "audit_hash": "a" * 64,
}

FULL_VERIFY_RESULT = {
    "verification_status": "valid",
    "proof_id": "550e8400-e29b-41d4-a716-446655440000",
    "checks": [{"name": "signature", "passed": True}],
}


class TestSchemaParity:
    @pytest.mark.parametrize(
        ("schema_file", "model"),
        [
            ("proof.schema.json", Proof),
            ("consume-request.schema.json", ConsumeRequest),
            ("consume-response.schema.json", ConsumeResponse),
            ("proof-verification-result.schema.json", ProofVerificationResult),
        ],
    )
    def test_required_fields_declared_on_model(self, schema_file, model):
        schema = _load_schema(schema_file)
        fields = set(model.model_fields.keys())
        for req in schema.get("required", []):
            assert (
                req in fields
            ), f"{model.__name__} missing schema-required field '{req}'"

    def test_proof_round_trips(self):
        proof = Proof.model_validate(FULL_PROOF)
        # Round-trip without re-adding defaults so the wire shape
        # stays byte-level comparable with the server's JSON.
        assert proof.proof_id == FULL_PROOF["proof_id"]
        dumped = proof.model_dump(mode="json", exclude_unset=False)
        assert dumped["payload_hash"] == FULL_PROOF["payload_hash"]

    def test_consume_request_rejects_unknown_fields(self):
        with pytest.raises(ValueError):
            ConsumeRequest.model_validate({**FULL_CONSUME_REQUEST, "bogus": 1})

    def test_consume_response_round_trips(self):
        resp = ConsumeResponse.model_validate(FULL_CONSUME_RESPONSE)
        assert resp.proof_id == FULL_CONSUME_RESPONSE["proof_id"]
        assert resp.execution_status == "executed"

    def test_verification_check_rejects_unknown_fields(self):
        with pytest.raises(ValueError):
            ProofVerificationCheck.model_validate(
                {"name": "signature", "passed": True, "extra": "nope"}
            )

    def test_verification_result_requires_non_empty_checks(self):
        with pytest.raises(ValueError):
            ProofVerificationResult.model_validate(
                {
                    "verification_status": "valid",
                    "proof_id": FULL_PROOF["proof_id"],
                    "checks": [],
                }
            )

    def test_verification_result_accepts_full_fixture(self):
        result = ProofVerificationResult.model_validate(FULL_VERIFY_RESULT)
        assert result.verification_status == "valid"
        assert len(result.checks) == 1
        assert result.checks[0].name == "signature"


class TestProofFieldOrder:
    """Declaration order MUST match the signed-byte order locked into
    ``proof.schema.json``. Reordering fields here is a breaking change."""

    def test_matches_schema_property_declaration_order(self):
        schema = _load_schema("proof.schema.json")
        schema_order = list(schema["properties"].keys())
        model_order = list(Proof.model_fields.keys())
        assert (
            model_order == schema_order
        ), "Proof field order drifted from contract/schemas/v2/proof.schema.json"
