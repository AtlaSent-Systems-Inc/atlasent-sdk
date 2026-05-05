"""Python contract-parity tests for the approval-artifact surface.

Mirrors the TypeScript SDK's approval-artifact vector tests
(``atlasent-sdk/typescript/test/approval-artifact-vectors.test.ts``).

Three responsibilities:

1. **Vector loading.** Every fixture JSON in
   ``contract/vectors/approval-artifact/`` parses cleanly into
   :class:`atlasent.ApprovalArtifactV1`. If a producer ever adds /
   renames a field, the schema, the TS types, the Python types, and
   the fixtures all have to be touched together — this test fails
   first when they fall out of sync.

2. **Wire-shape parity.** ``EvaluateRequest.approval`` round-trips
   through the canonical wire dump and re-parse without losing any
   field; the dumped dict matches what the verifier on the
   atlasent-console / atlasent-api Deno path expects.

3. **Result-model parity.** ``EvaluateResult`` populates
   ``permit_approval`` from BOTH wire shapes the server may emit
   (atlasent-console nests under ``permit.approval`` per PermitV2;
   atlasent-api exposes top-level ``permit_approval``).
   ``VerifyResult`` surfaces the persisted binding plus the
   ``APPROVAL_LINKAGE_MISSING`` downgrade fields.

No new behavior is introduced: this PR is contract parity only.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from atlasent import (
    ApprovalArtifactV1,
    ApprovalIssuer,
    ApprovalReference,
    ApprovalReviewer,
    ApprovalTrustedIssuersConfig,
    EvaluateResult,
    PermitApprovalBinding,
    TrustedIssuerKey,
    VerifyResult,
)
from atlasent.models import EvaluateRequest, VerifyRequest


# ── Locate the cross-repo vectors. The Python SDK lives one level
# below the contract dir, so walk up two parents. We tolerate the
# vectors being absent in install layouts that ship the Python wheel
# without the contract dir — those environments skip these tests.
VECTORS_DIR = (
    Path(__file__).resolve().parent.parent.parent
    / "contract"
    / "vectors"
    / "approval-artifact"
)


def _load_vector(name: str) -> dict:
    path = VECTORS_DIR / f"{name}.json"
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


pytestmark = pytest.mark.skipif(
    not VECTORS_DIR.exists(),
    reason="contract/vectors/approval-artifact not available in this layout",
)


# ── 1. Vector loading ────────────────────────────────────────────────

VECTOR_NAMES = [
    "valid",
    "expired",
    "wrong-hash",
    "agent-reviewer",
    "missing-role",
    "untrusted-issuer",
    "wrong-signature",
    "replay",
]


@pytest.mark.parametrize("name", VECTOR_NAMES)
def test_vector_artifact_parses_into_pydantic_model(name: str) -> None:
    """Every TS-SDK vector parses into the Python ApprovalArtifactV1.

    Drift detector: if a field is added/renamed in the schema (and the
    fixtures regenerated) but not mirrored in the Python model, this
    parametrized test fails immediately for the affected vector.
    """
    vector = _load_vector(name)
    artifact = ApprovalArtifactV1.model_validate(vector["artifact"])
    assert artifact.version == "approval_artifact.v1"
    assert artifact.approval_id == vector["artifact"]["approval_id"]
    # Round-trip preserves canonical wire shape.
    assert artifact.model_dump(exclude_none=True) == vector["artifact"]


def test_valid_vector_carries_human_reviewer() -> None:
    valid = _load_vector("valid")
    artifact = ApprovalArtifactV1.model_validate(valid["artifact"])
    assert artifact.reviewer.principal_kind == "human"
    assert "qa_reviewer" in (artifact.reviewer.roles or [])


def test_agent_reviewer_vector_carries_agent_kind() -> None:
    """The agent-reviewer fixture is structurally valid (the schema
    permits the enum value); the *verifier* is what rejects it. The
    Python model must not artificially block it — that would mask
    server-side denials in client-side tests.
    """
    agent = _load_vector("agent-reviewer")
    artifact = ApprovalArtifactV1.model_validate(agent["artifact"])
    assert artifact.reviewer.principal_kind == "agent"


def test_action_hash_pattern_enforced() -> None:
    bad = _load_vector("valid")
    bad["artifact"]["action_hash"] = "not-a-sha256-hex"
    with pytest.raises(ValidationError):
        ApprovalArtifactV1.model_validate(bad["artifact"])


def test_extra_field_is_rejected() -> None:
    """``extra="forbid"`` so a typo'd / renamed field surfaces as a
    pydantic error at SDK boundaries instead of silently propagating
    onto the wire."""
    bad = _load_vector("valid")["artifact"].copy()
    bad["unknown_field"] = "oops"
    with pytest.raises(ValidationError):
        ApprovalArtifactV1.model_validate(bad)


# ── 2. EvaluateRequest wire shape ─────────────────────────────────────


def test_evaluate_request_carries_approval_artifact_on_the_wire() -> None:
    valid = _load_vector("valid")
    req = EvaluateRequest(
        action_type="deployment.production.deploy",
        actor_id="agent_test_1",
        resource_id="release:abc123",
        approval=ApprovalReference(
            artifact=ApprovalArtifactV1.model_validate(valid["artifact"]),
        ),
        require_approval=True,
    )
    wire = req.model_dump(by_alias=True, exclude_none=True)
    assert wire["approval"]["artifact"]["version"] == "approval_artifact.v1"
    assert wire["approval"]["artifact"]["nonce"] == valid["artifact"]["nonce"]
    assert wire["require_approval"] is True
    # api_key is excluded from the wire even when omitted.
    assert "api_key" not in wire


def test_evaluate_request_accepts_dict_for_approval() -> None:
    """Ergonomics: callers can pass a plain dict matching
    ``ApprovalReference``; the model validates it. Mirrors what the
    client does internally so users get type checking for free."""
    valid = _load_vector("valid")
    req = EvaluateRequest(
        action_type="deployment.production.deploy",
        actor_id="agent_test_1",
        approval={"approval_id": "apr_xyz", "artifact": valid["artifact"]},
    )
    assert req.approval is not None
    assert req.approval.approval_id == "apr_xyz"
    assert req.approval.artifact is not None
    assert req.approval.artifact.version == "approval_artifact.v1"


def test_evaluate_request_approval_id_only_reference() -> None:
    req = EvaluateRequest(
        action_type="deployment.production.deploy",
        actor_id="agent_test_1",
        approval=ApprovalReference(approval_id="apr_xyz"),
    )
    wire = req.model_dump(by_alias=True, exclude_none=True)
    assert wire["approval"] == {"approval_id": "apr_xyz"}


def test_evaluate_request_omits_approval_when_unset() -> None:
    req = EvaluateRequest(action_type="x", actor_id="y")
    wire = req.model_dump(by_alias=True, exclude_none=True)
    assert "approval" not in wire
    assert "require_approval" not in wire


# ── 3. VerifyRequest wire shape ───────────────────────────────────────


def test_verify_request_carries_require_approval_on_the_wire() -> None:
    req = VerifyRequest(permit_token="pt_x", require_approval=True)
    wire = req.model_dump(by_alias=True, exclude_none=True)
    assert wire["require_approval"] is True
    # context is excluded from the wire even when present.
    assert "context" not in wire


def test_verify_request_omits_require_approval_when_unset() -> None:
    req = VerifyRequest(permit_token="pt_x")
    wire = req.model_dump(by_alias=True, exclude_none=True)
    assert "require_approval" not in wire


# ── 4. EvaluateResult — permit_approval from both wire shapes ─────────


_BINDING = {
    "approval_id": "apr_xyz",
    "artifact_hash": "f" * 64,
    "reviewer_id": "okta|u1",
    "issuer_id": "issuer.qa",
    "kid": "kid-1",
}


def test_evaluate_result_picks_up_console_nested_permit_approval() -> None:
    """atlasent-console returns ``permit.approval`` per PermitV2."""
    result = EvaluateResult.model_validate({
        "decision": "allow",
        "permit_token": "pt_x",
        "permit": {"token": "pt_x", "approval": _BINDING},
    })
    assert isinstance(result.permit_approval, PermitApprovalBinding)
    assert result.permit_approval.approval_id == "apr_xyz"


def test_evaluate_result_picks_up_api_top_level_permit_approval() -> None:
    """atlasent-api exposes top-level ``permit_approval``."""
    result = EvaluateResult.model_validate({
        "decision": "allow",
        "permit_token": "pt_x",
        "permit_approval": _BINDING,
    })
    assert isinstance(result.permit_approval, PermitApprovalBinding)
    assert result.permit_approval.artifact_hash == _BINDING["artifact_hash"]


def test_evaluate_result_permit_approval_absent_when_no_binding() -> None:
    result = EvaluateResult.model_validate({
        "decision": "allow",
        "permit_token": "pt_x",
    })
    assert result.permit_approval is None


# ── 5. VerifyResult — approval + consumed + APPROVAL_LINKAGE_MISSING ──


def test_verify_result_surfaces_binding_on_success() -> None:
    result = VerifyResult.model_validate({
        "valid": True,
        "outcome": "allow",
        "consumed": True,
        "approval": _BINDING,
    })
    assert result.valid is True
    assert result.consumed is True
    assert result.approval is not None
    assert result.approval.kid == "kid-1"


def test_verify_result_approval_linkage_missing_downgrade() -> None:
    """``APPROVAL_LINKAGE_MISSING`` returns ``valid=False`` AND
    ``consumed=True`` — the permit is burned, do not retry."""
    result = VerifyResult.model_validate({
        "valid": False,
        "outcome": "deny",
        "verify_error_code": "APPROVAL_LINKAGE_MISSING",
        "reason": "permit lacks approval binding for an approval-required action",
        "consumed": True,
        "approval": None,
    })
    assert result.valid is False
    assert result.consumed is True
    assert result.verify_error_code == "APPROVAL_LINKAGE_MISSING"
    assert result.approval is None


# ── 6. ApprovalTrustedIssuersConfig — lockstep with TS schema ────────


def test_trusted_issuers_config_round_trips_via_env_dict() -> None:
    """The config the server reads from ``APPROVAL_TRUSTED_ISSUERS``
    has the shape published in
    ``contract/schemas/trusted-issuers-config.schema.json``. The
    Python model parses and re-emits that dict losslessly so
    operators can lint config in CI."""
    raw = {
        "issuer.qa": {
            "kid-1": {
                "alg": "HS256",
                "key": "5555555555555555555555555555555555555555555555555555555555555555",
                "allowed_action_types": ["deployment.production.*"],
                "allowed_environments": ["production"],
                "required_role": "qa_reviewer",
            },
        },
    }
    cfg = ApprovalTrustedIssuersConfig.from_env_dict(raw)
    assert cfg.to_env_dict() == raw

    entry = cfg.root["issuer.qa"]["kid-1"]
    assert isinstance(entry, TrustedIssuerKey)
    assert entry.alg == "HS256"
    assert entry.allowed_action_types == ["deployment.production.*"]


def test_trusted_issuers_config_unscoped_entry_has_none_defaults() -> None:
    """Empty/missing scope fields mean 'any' for that dimension."""
    cfg = ApprovalTrustedIssuersConfig.from_env_dict({
        "issuer.qa": {"kid-1": {"alg": "HS256", "key": "00" * 32}},
    })
    entry = cfg.root["issuer.qa"]["kid-1"]
    assert entry.allowed_action_types is None
    assert entry.allowed_environments is None
    assert entry.required_role is None


def test_trusted_issuers_config_rejects_unknown_alg() -> None:
    with pytest.raises(ValidationError):
        ApprovalTrustedIssuersConfig.from_env_dict({
            "issuer.qa": {"kid-1": {"alg": "RS256", "key": "deadbeef"}},
        })


# ── 7. Sub-shape parity helpers ───────────────────────────────────────


def test_approval_reviewer_kinds() -> None:
    for kind in ("human", "agent", "service_account"):
        ApprovalReviewer(principal_id="x", principal_kind=kind)
    with pytest.raises(ValidationError):
        ApprovalReviewer(principal_id="x", principal_kind="bot")  # type: ignore[arg-type]


def test_approval_issuer_types() -> None:
    for t in ("oidc", "approval_service"):
        ApprovalIssuer(type=t, issuer_id="i", kid="k")
    with pytest.raises(ValidationError):
        ApprovalIssuer(type="other", issuer_id="i", kid="k")  # type: ignore[arg-type]
