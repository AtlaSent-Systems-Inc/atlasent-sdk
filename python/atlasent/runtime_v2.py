"""Runtime v2 client — authorized-state-change lifecycle.

Thin client layer over the ``/v2/orgs/:org_id/…`` endpoints landed in
``atlasent-api`` PR #1031.  Wraps an existing :class:`AtlaSentClient`
and exposes the four-plane runtime surface:

* **Control** — ``authorize()`` issues permits or pends approval
* **Verification** — ``consume()`` pre-execution verify + atomic consume;
  ``complete()`` post-execution verify + receipt
* **Evidence** — ``submit_evidence()``, ``get_evidence()``, audit chain
* **Authority** — CRUD + rotate + revoke for authority records

The v1 substrate is frozen (post-GA 2026-05-17). This module is
purely additive. Pass your existing :class:`AtlaSentClient` to
:func:`runtime` to get a :class:`RuntimeV2Client`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal

from .exceptions import AtlaSentError

if TYPE_CHECKING:
    from .client import AtlaSentClient


# ── Wire types ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class VerificationFailure:
    code: str
    message: str
    field: str | None = None


@dataclass(frozen=True)
class VerificationResult:
    passed: bool
    verified_at: str
    failures: tuple[VerificationFailure, ...] = ()
    warnings: tuple[dict[str, Any], ...] = ()


@dataclass(frozen=True)
class ExecutionReceipt:
    receipt_id: str
    permit_id: str
    org_id: str
    issued_at: str
    post_state_fingerprint: str
    evidence_id: str


@dataclass(frozen=True)
class PostExecutionResult:
    verified: bool
    evidence_completeness: Literal["COMPLETE", "PARTIAL", "FAILED"]
    failures: tuple[VerificationFailure, ...] = ()
    receipt: ExecutionReceipt | None = None


@dataclass(frozen=True)
class AuthorizationDecision:
    status: Literal["PERMITTED", "PENDING_APPROVAL", "DENIED", "ERROR"]
    permit: dict[str, Any] | None = None
    required_approvers: tuple[str, ...] = ()
    reasons: tuple[str, ...] = ()
    policy_ids: tuple[str, ...] = ()
    code: str | None = None
    message: str | None = None


@dataclass(frozen=True)
class AuthorityRecord:
    authority_id: str
    org_id: str
    name: str
    action_classes: tuple[str, ...]
    public_key: str
    key_id: str
    status: str
    created_at: str
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class EvidencePackage:
    evidence_id: str
    permit_id: str
    org_id: str
    observations: tuple[dict[str, Any], ...]
    collected_at: str
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class RuntimeAuditEntry:
    entry_id: str
    org_id: str
    sequence: int
    receipt_id: str
    prior_hash: str
    entry_hash: str
    appended_at: str


@dataclass(frozen=True)
class AuditChainPage:
    entries: tuple[RuntimeAuditEntry, ...]
    total: int
    page: int
    page_size: int


@dataclass(frozen=True)
class ChainIntegrityReport:
    valid: bool
    checked_entries: int
    first_sequence: int
    last_sequence: int
    gaps: tuple[int, ...]
    invalid_hashes: tuple[int, ...]
    verified_at: str


@dataclass(frozen=True)
class ComplianceExport:
    export_id: str
    org_id: str
    from_: str
    to: str
    entry_count: int
    format: str
    content_ref: str
    content_hash: str
    generated_at: str
    signed_by: str


# ── Helpers ───────────────────────────────────────────────────────────────────


def _org_path(org_id: str, *parts: str) -> str:
    base = f"/v2/orgs/{org_id}"
    return base if not parts else f"{base}/{'/'.join(parts)}"


def _raise(body: dict[str, Any], status: int, path: str) -> None:
    err = body.get("error", {})
    raise AtlaSentError(
        err.get("message", f"v2 runtime error {status} on {path}"),
        status_code=status,
        code=err.get("code", "runtime_error"),
    )


def _vf(f: dict[str, Any]) -> VerificationFailure:
    return VerificationFailure(
        code=f.get("code", "UNKNOWN"),
        message=f.get("message", ""),
        field=f.get("field"),
    )


def _parse_verification(data: dict[str, Any]) -> VerificationResult:
    return VerificationResult(
        passed=bool(data.get("passed")),
        verified_at=str(data.get("verified_at", "")),
        failures=tuple(_vf(f) for f in data.get("failures", [])),
        warnings=tuple(data.get("warnings", [])),
    )


def _parse_authority(data: dict[str, Any]) -> AuthorityRecord:
    return AuthorityRecord(
        authority_id=str(data["authority_id"]),
        org_id=str(data["org_id"]),
        name=str(data.get("name", "")),
        action_classes=tuple(data.get("action_classes", [])),
        public_key=str(data.get("public_key", "")),
        key_id=str(data.get("key_id", "")),
        status=str(data.get("status", "")),
        created_at=str(data.get("created_at", "")),
        extra={
            k: v
            for k, v in data.items()
            if k
            not in {
                "authority_id",
                "org_id",
                "name",
                "action_classes",
                "public_key",
                "key_id",
                "status",
                "created_at",
            }
        },
    )


# ── Client ────────────────────────────────────────────────────────────────────


class RuntimeV2Client:
    """Runtime v2 client — wraps :class:`AtlaSentClient` for the v2 planes.

    Obtain via :func:`runtime`::

        from atlasent import AtlaSentClient
        from atlasent.runtime_v2 import runtime

        rvc = runtime(AtlaSentClient(api_key="ask_…"))
        decision = rvc.authorize(org_id, transition_request)
    """

    def __init__(self, client: AtlaSentClient) -> None:
        self._c = client

    # ── Control plane ──────────────────────────────────────────────────────────

    def authorize(
        self,
        org_id: str,
        request: dict[str, Any],
    ) -> AuthorizationDecision:
        """``POST /v2/orgs/:org_id/transitions``.

        Returns an :class:`AuthorizationDecision` with status
        ``PERMITTED``, ``PENDING_APPROVAL``, ``DENIED``, or ``ERROR``.
        The ``permit`` field is populated for PERMITTED and PENDING.
        """
        path = _org_path(org_id, "transitions")
        data, _, _ = self._c._post(path, request)  # noqa: SLF001
        status = data.get("status", "ERROR")
        return AuthorizationDecision(
            status=status,
            permit=data.get("permit"),
            required_approvers=tuple(data.get("required_approvers", [])),
            reasons=tuple(data.get("reasons", [])),
            policy_ids=tuple(data.get("policy_ids", [])),
            code=data.get("code"),
            message=data.get("message"),
        )

    # ── Permit plane ───────────────────────────────────────────────────────────

    def get_permit(self, org_id: str, permit_id: str) -> dict[str, Any] | None:
        """``GET /v2/orgs/:org_id/permits/:permit_id``."""
        path = _org_path(org_id, "permits", permit_id)
        data, _, _ = self._c._get(path)  # noqa: SLF001
        return data.get("permit")

    def consume(
        self,
        org_id: str,
        permit_id: str,
        observed_source_fingerprint: str,
    ) -> VerificationResult:
        """``POST /v2/orgs/:org_id/permits/:permit_id/consume``.

        Atomically validates the permit and increments uses_consumed.
        Returns a :class:`VerificationResult`; raises on HTTP error.
        """
        path = _org_path(org_id, "permits", permit_id, "consume")
        data, _, _ = self._c._post(  # noqa: SLF001
            path, {"observed_source_fingerprint": observed_source_fingerprint}
        )
        return _parse_verification(data)

    def approve(
        self,
        org_id: str,
        permit_id: str,
        approver_did: str,
        signature: str,
        comment: str | None = None,
    ) -> dict[str, Any]:
        """``POST /v2/orgs/:org_id/permits/:permit_id/approve``.

        Returns ``{"approved": bool, "status": str}``.
        """
        path = _org_path(org_id, "permits", permit_id, "approve")
        payload: dict[str, Any] = {
            "approver_did": approver_did,
            "signature": signature,
        }
        if comment is not None:
            payload["comment"] = comment
        data, _, _ = self._c._post(path, payload)  # noqa: SLF001
        return data

    def complete(
        self,
        org_id: str,
        permit_id: str,
        evidence_id: str,
        observed_post_fingerprint: str,
    ) -> PostExecutionResult:
        """``POST /v2/orgs/:org_id/permits/:permit_id/complete``.

        Verifies post-execution state and issues an execution receipt.
        """
        path = _org_path(org_id, "permits", permit_id, "complete")
        data, _, _ = self._c._post(  # noqa: SLF001
            path,
            {
                "evidence_id": evidence_id,
                "observed_post_fingerprint": observed_post_fingerprint,
            },
        )
        receipt_data = data.get("receipt")
        receipt = None
        if receipt_data:
            receipt = ExecutionReceipt(
                receipt_id=str(receipt_data.get("receipt_id", "")),
                permit_id=str(receipt_data.get("permit_id", "")),
                org_id=str(receipt_data.get("org_id", "")),
                issued_at=str(receipt_data.get("issued_at", "")),
                post_state_fingerprint=str(
                    receipt_data.get("post_state_fingerprint", "")
                ),
                evidence_id=str(receipt_data.get("evidence_id", "")),
            )
        return PostExecutionResult(
            verified=bool(data.get("verified")),
            evidence_completeness=data.get("evidence_completeness", "FAILED"),
            failures=tuple(_vf(f) for f in data.get("failures", [])),
            receipt=receipt,
        )

    def revoke_permit(
        self,
        org_id: str,
        permit_id: str,
        revoked_by: str,
        reason: str,
        *,
        propagates_to_children: bool = False,
    ) -> None:
        """``DELETE /v2/orgs/:org_id/permits/:permit_id``."""
        import json as _json

        url = f"{self._c._base_url}{_org_path(org_id, 'permits', permit_id)}"  # noqa: SLF001
        body = _json.dumps(
            {
                "revoked_by": revoked_by,
                "reason": reason,
                "propagates_to_children": propagates_to_children,
            }
        ).encode()
        resp = self._c._client.request(  # noqa: SLF001
            "DELETE",
            url,
            content=body,
            headers={"Content-Type": "application/json"},
        )
        if resp.status_code >= 400:
            _raise(resp.json(), resp.status_code, "DELETE permits/:id")

    # ── Authority plane ────────────────────────────────────────────────────────

    def list_authorities(
        self,
        org_id: str,
        include_inactive: bool = False,
    ) -> list[AuthorityRecord]:
        """``GET /v2/orgs/:org_id/authorities``."""
        path = _org_path(org_id, "authorities")
        params = {"include_inactive": "true"} if include_inactive else None
        data, _, _ = self._c._get(path, params=params)  # noqa: SLF001
        return [_parse_authority(a) for a in data.get("authorities", [])]

    def create_authority(self, org_id: str, record: dict[str, Any]) -> AuthorityRecord:
        """``POST /v2/orgs/:org_id/authorities``."""
        path = _org_path(org_id, "authorities")
        data, _, _ = self._c._post(path, record)  # noqa: SLF001
        return _parse_authority(data.get("authority", data))

    def get_authority(self, org_id: str, authority_id: str) -> AuthorityRecord | None:
        """``GET /v2/orgs/:org_id/authorities/:authority_id``."""
        path = _org_path(org_id, "authorities", authority_id)
        data, _, _ = self._c._get(path)  # noqa: SLF001
        raw = data.get("authority")
        return _parse_authority(raw) if raw else None

    def rotate_authority(
        self,
        org_id: str,
        authority_id: str,
        new_public_key: str,
        new_key_id: str,
    ) -> AuthorityRecord:
        """``POST /v2/orgs/:org_id/authorities/:authority_id/rotate``."""
        path = _org_path(org_id, "authorities", authority_id, "rotate")
        data, _, _ = self._c._post(  # noqa: SLF001
            path, {"new_public_key": new_public_key, "new_key_id": new_key_id}
        )
        return _parse_authority(data.get("authority", data))

    def revoke_authority(self, org_id: str, authority_id: str, reason: str) -> None:
        """``POST /v2/orgs/:org_id/authorities/:authority_id/revoke``."""
        path = _org_path(org_id, "authorities", authority_id, "revoke")
        self._c._post(path, {"reason": reason})  # noqa: SLF001

    # ── Evidence plane ─────────────────────────────────────────────────────────

    def submit_evidence(self, org_id: str, pkg: dict[str, Any]) -> None:
        """``POST /v2/orgs/:org_id/evidence``."""
        path = _org_path(org_id, "evidence")
        self._c._post(path, pkg)  # noqa: SLF001

    def get_evidence(self, org_id: str, evidence_id: str) -> dict[str, Any] | None:
        """``GET /v2/orgs/:org_id/evidence/:evidence_id``."""
        path = _org_path(org_id, "evidence", evidence_id)
        data, _, _ = self._c._get(path)  # noqa: SLF001
        return data.get("evidence")

    def query_audit_chain(
        self,
        org_id: str,
        from_: str,
        to: str,
        *,
        page: int = 1,
        page_size: int = 100,
        action_class: str | None = None,
        principal_did: str | None = None,
        resource_locator: str | None = None,
    ) -> AuditChainPage:
        """``GET /v2/orgs/:org_id/audit-chain``."""
        path = _org_path(org_id, "audit-chain")
        params: dict[str, str] = {
            "from": from_,
            "to": to,
            "page": str(page),
            "page_size": str(page_size),
        }
        if action_class:
            params["action_class"] = action_class
        if principal_did:
            params["principal_did"] = principal_did
        if resource_locator:
            params["resource_locator"] = resource_locator
        data, _, _ = self._c._get(path, params=params)  # noqa: SLF001
        entries = tuple(
            RuntimeAuditEntry(
                entry_id=str(e["entry_id"]),
                org_id=str(e["org_id"]),
                sequence=int(e["sequence"]),
                receipt_id=str(e["receipt_id"]),
                prior_hash=str(e["prior_hash"]),
                entry_hash=str(e["entry_hash"]),
                appended_at=str(e["appended_at"]),
            )
            for e in data.get("entries", [])
        )
        return AuditChainPage(
            entries=entries,
            total=int(data.get("total", 0)),
            page=int(data.get("page", page)),
            page_size=int(data.get("page_size", page_size)),
        )

    def verify_chain_integrity(
        self,
        org_id: str,
        from_sequence: int,
        to_sequence: int,
    ) -> ChainIntegrityReport:
        """``GET /v2/orgs/:org_id/audit-chain/integrity``."""
        path = _org_path(org_id, "audit-chain", "integrity")
        data, _, _ = self._c._get(  # noqa: SLF001
            path,
            params={
                "from_sequence": str(from_sequence),
                "to_sequence": str(to_sequence),
            },
        )
        return ChainIntegrityReport(
            valid=bool(data.get("valid")),
            checked_entries=int(data.get("checked_entries", 0)),
            first_sequence=int(data.get("first_sequence", from_sequence)),
            last_sequence=int(data.get("last_sequence", to_sequence)),
            gaps=tuple(data.get("gaps", [])),
            invalid_hashes=tuple(data.get("invalid_hashes", [])),
            verified_at=str(data.get("verified_at", "")),
        )

    def export_compliance(
        self,
        org_id: str,
        from_: str,
        to: str,
        format: Literal["JSON", "CSV", "CISA_SBOM"] = "JSON",
    ) -> ComplianceExport:
        """``POST /v2/orgs/:org_id/compliance-export``."""
        path = _org_path(org_id, "compliance-export")
        data, _, _ = self._c._post(  # noqa: SLF001
            path, {"from": from_, "to": to, "format": format}
        )
        return ComplianceExport(
            export_id=str(data.get("export_id", "")),
            org_id=str(data.get("org_id", org_id)),
            from_=str(data.get("from", from_)),
            to=str(data.get("to", to)),
            entry_count=int(data.get("entry_count", 0)),
            format=str(data.get("format", format)),
            content_ref=str(data.get("content_ref", "")),
            content_hash=str(data.get("content_hash", "")),
            generated_at=str(data.get("generated_at", "")),
            signed_by=str(data.get("signed_by", "")),
        )


# ── Factory ───────────────────────────────────────────────────────────────────


def runtime(client: AtlaSentClient) -> RuntimeV2Client:
    """Return a :class:`RuntimeV2Client` backed by *client*.

    Example::

        from atlasent import AtlaSentClient
        from atlasent.runtime_v2 import runtime

        rvc = runtime(AtlaSentClient(api_key="ask_…"))
        decision = rvc.authorize("org_acme", {"transition": {...}})
    """
    return RuntimeV2Client(client)
