"""Approval artifact models — wire-stable as ``approval_artifact.v1``.

Mirrors the TypeScript SDK
(``atlasent-sdk/typescript/src/approvalArtifact.ts``) and the JSON
Schema (``contract/schemas/approval-artifact.schema.json``). Verifier
behavior lives server-side inside ``/v1-evaluate``; the Python SDK
just *carries* the artifact and surfaces the binding back from
``/v1-verify-permit``.

Why this matters: the calling agent cannot self-declare authority
by passing reviewer flags in ``context``. The artifact is bound to
the exact action via ``action_hash``, signed by a trusted issuer,
and replay-protected via ``nonce``. See ``contract/APPROVAL_DENY_REASONS.md``
for the verifier's 13-step check order.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

PrincipalKind = Literal["human", "agent", "service_account"]
"""What kind of principal performed the approval. The verifier
requires ``"human"``; the other variants exist so the schema can
describe declined approvals (e.g. an agent attempted to self-approve).
"""


class ApprovalReviewer(BaseModel):
    """Identity of the reviewer recorded inside the artifact."""

    principal_id: str
    principal_kind: PrincipalKind
    email: Optional[str] = None
    groups: Optional[list[str]] = None
    roles: Optional[list[str]] = None

    model_config = ConfigDict(extra="forbid")


class ApprovalIssuer(BaseModel):
    """Trusted issuer identification — used to look up the verification key."""

    type: Literal["oidc", "approval_service"]
    issuer_id: str
    kid: str
    """Key id (for rotation)."""

    model_config = ConfigDict(extra="forbid")


class ApprovalArtifactV1(BaseModel):
    """The full signed approval artifact.

    Producers (approval services) compute ``action_hash`` over the
    canonical action payload and sign the artifact with the
    ``signature`` field stripped; the SDK does not sign or verify, it
    only carries the artifact to the server. Field order matches the
    JSON Schema; ``extra="forbid"`` so an unexpected key fails fast
    at SDK boundaries instead of silently propagating to the wire.
    """

    version: Literal["approval_artifact.v1"] = "approval_artifact.v1"
    approval_id: str = Field(min_length=1, max_length=256)
    tenant_id: str = Field(min_length=1, max_length=256)
    action_type: str = Field(min_length=1, max_length=256)
    resource_id: str = Field(min_length=1, max_length=512)
    action_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    reviewer: ApprovalReviewer
    issuer: ApprovalIssuer
    issued_at: str
    expires_at: str
    nonce: str = Field(min_length=8)
    signature: str = Field(min_length=1)

    model_config = ConfigDict(extra="forbid")


class ApprovalReference(BaseModel):
    """Optional ``approval`` field on an evaluate request.

    Either embed the full artifact (``artifact=...``), or pass an
    ``approval_id`` and let the server resolve it from a side channel
    (preferred when the artifact is large).
    """

    approval_id: Optional[str] = None
    artifact: Optional[ApprovalArtifactV1] = None

    model_config = ConfigDict(extra="forbid")


class PermitApprovalBinding(BaseModel):
    """Cryptographic permit ↔ approval-artifact linkage.

    Set when the evaluate path verified an ``approval_artifact.v1``
    before issuing a permit; persisted on the permit row so
    ``/v1-verify-permit`` can enforce the full chain on consume.
    Returned on ``EvaluateResult.permit.approval`` and on
    ``VerifyResult.approval``.
    """

    approval_id: str
    """``approval_artifact.approval_id`` from the verified artifact."""

    artifact_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    """SHA-256 over the artifact's canonical signing payload (i.e. the
    artifact with the ``signature`` field stripped). Lets a stored
    permit row prove which artifact authorized it without retaining
    the full artifact body."""

    reviewer_id: str
    """``reviewer.principal_id`` from the verified artifact."""

    issuer_id: str
    """``issuer.issuer_id`` from the verified artifact."""

    kid: str
    """``issuer.kid`` used to verify the signature (key id, for rotation)."""

    model_config = ConfigDict(extra="forbid")


# ── Trusted-issuer config (server-side, never on the wire) ────────────


class TrustedIssuerKey(BaseModel):
    """One entry in ``APPROVAL_TRUSTED_ISSUERS[issuer_id][kid]``.

    Server-side config only — read by the verifier inside
    ``/v1-evaluate``. The Python SDK exposes the model so operators
    can construct / lint / round-trip the env-var JSON.
    """

    alg: Literal["HS256", "Ed25519"]
    """Signature algorithm. HS256 = HMAC-SHA-256 with a hex-encoded
    shared secret. Ed25519 = detached signature with a hex-encoded
    32-byte raw public key."""

    key: str = Field(min_length=1)
    """Hex-encoded HS256 secret (any byte length) or Ed25519 raw
    public key (32 bytes / 64 hex chars). Ed25519 signatures may be
    hex or base64url; HS256 signatures are hex only."""

    allowed_action_types: Optional[list[str]] = None
    """Per-issuer scope: ``action_types`` this kid may approve.
    Entries match exactly OR with a trailing ``.*`` wildcard (e.g.
    ``deployment.production.*`` matches ``deployment.production.deploy``).
    Empty / missing = unscoped on action types."""

    allowed_environments: Optional[list[str]] = None
    """Per-issuer scope: environments this kid may approve in (e.g.
    ``["production"]``). Empty / missing = unscoped."""

    required_role: Optional[str] = None
    """When set, the issuer's ``required_role`` wins over the caller's
    ``requiredRole``. A misconfigured caller cannot broaden this
    issuer's authority."""

    model_config = ConfigDict(extra="forbid")


class ApprovalTrustedIssuersConfig(BaseModel):
    """JSON shape of the ``APPROVAL_TRUSTED_ISSUERS`` env var.

    Keyed by ``issuer_id`` then by ``kid``::

        {
          "issuer.qa": {
            "kid-1": {
              "alg": "HS256",
              "key": "<hex>",
              "allowed_action_types": ["deployment.production.*"],
              "allowed_environments": ["production"],
              "required_role": "qa_reviewer"
            }
          }
        }

    Use :meth:`from_env_str` to parse the JSON bytes that the server
    process reads from the environment. Validation surfaces config
    errors at deploy time rather than at the first denied evaluate.
    """

    root: dict[str, dict[str, TrustedIssuerKey]]
    """``issuer_id`` → ``kid`` → key entry."""

    model_config = ConfigDict(extra="forbid")

    def to_env_dict(self) -> dict[str, Any]:
        """Render to the plain dict shape stored in the env var."""
        return {
            issuer_id: {
                kid: entry.model_dump(exclude_none=True)
                for kid, entry in kids.items()
            }
            for issuer_id, kids in self.root.items()
        }

    @classmethod
    def from_env_dict(cls, data: dict[str, Any]) -> ApprovalTrustedIssuersConfig:
        """Parse the plain dict shape stored in the env var."""
        return cls(root=data)  # type: ignore[arg-type]


__all__ = [
    "ApprovalArtifactV1",
    "ApprovalIssuer",
    "ApprovalReference",
    "ApprovalReviewer",
    "ApprovalTrustedIssuersConfig",
    "PermitApprovalBinding",
    "PrincipalKind",
    "TrustedIssuerKey",
]
