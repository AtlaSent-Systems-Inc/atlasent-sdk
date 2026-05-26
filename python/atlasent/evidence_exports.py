"""Evidence bundle export helpers (Wave B parity).

Standalone functions that sit on top of an :class:`~atlasent.AtlaSentClient`
and call the evidence-export endpoints in ``atlasent-api``:

    GET  /v1/orgs/{orgId}/evidence-exports
    GET  /v1/orgs/{orgId}/evidence-exports/{exportId}
    POST /v1/orgs/{orgId}/evidence-exports

Usage::

    from atlasent import AtlaSentClient
    from atlasent.evidence_exports import (
        list_evidence_exports,
        get_evidence_export,
        create_evidence_export,
    )

    client = AtlaSentClient(api_key="...", base_url="...")
    exports = list_evidence_exports(client, "org_abc", regime="soc2_type_ii")
    for record in exports["exports"]:
        print(record["id"], record["regime"], record["bundle_sha256"])

    export = create_evidence_export(
        client,
        "org_abc",
        regime="hipaa",
        window={"from": "2026-02-01T00:00:00Z", "to": "2026-05-01T00:00:00Z"},
    )
    print("created:", export["export"]["id"])
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any, Literal
from urllib.parse import quote

from .exceptions import AtlaSentError

if TYPE_CHECKING:
    from .client import AtlaSentClient

RegimeId = Literal["soc2_type_ii", "hipaa", "gdpr"]

_VALID_REGIMES: frozenset[str] = frozenset({"soc2_type_ii", "hipaa", "gdpr"})


def _enc(value: str) -> str:
    return quote(value, safe="")


def _do(
    client: AtlaSentClient,
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    url = f"{client._base_url}{path}"  # noqa: SLF001
    kwargs: dict[str, Any] = {}
    if body is not None:
        kwargs["content"] = json.dumps(body, separators=(",", ":")).encode()
        kwargs["headers"] = {"Content-Type": "application/json"}
    response = client._client.request(method, url, **kwargs)  # noqa: SLF001
    request_id = response.headers.get("X-Request-ID")
    if response.status_code >= 400:
        msg = None
        try:
            err = response.json()
            msg = err.get("error") or err.get("message")
        except (ValueError, AttributeError):
            pass
        raise AtlaSentError(
            msg or f"evidence-exports {method} {path} returned {response.status_code}",
            status_code=response.status_code,
            code="server_error" if response.status_code >= 500 else "bad_request",
            request_id=request_id,
        )
    try:
        return response.json()
    except ValueError as exc:
        raise AtlaSentError(
            f"evidence-exports {method} {path}: malformed JSON response",
            status_code=response.status_code,
            code="bad_response",
            request_id=request_id,
        ) from exc


def list_evidence_exports(
    client: AtlaSentClient,
    org_id: str,
    *,
    regime: RegimeId | None = None,
) -> dict[str, Any]:
    """``GET /v1/orgs/{orgId}/evidence-exports`` — list past evidence exports.

    Args:
        client: Initialised :class:`~atlasent.AtlaSentClient`.
        org_id: AtlaSent organisation ID.
        regime: Optional filter — ``"soc2_type_ii"``, ``"hipaa"``, or ``"gdpr"``.

    Returns:
        Dict with ``exports`` key containing a list of
        :class:`EvidenceExportRecord` dicts.

    Raises:
        ValueError: When ``regime`` is not a recognised value.
        atlasent.exceptions.AtlaSentError: On non-2xx responses.
    """
    if regime is not None and regime not in _VALID_REGIMES:
        raise ValueError(f"regime must be one of: {', '.join(sorted(_VALID_REGIMES))}")
    path = f"/v1/orgs/{_enc(org_id)}/evidence-exports"
    if regime is not None:
        path = f"{path}?regime={_enc(regime)}"
    return _do(client, "GET", path)


def get_evidence_export(
    client: AtlaSentClient,
    org_id: str,
    export_id: str,
) -> dict[str, Any]:
    """``GET /v1/orgs/{orgId}/evidence-exports/{exportId}`` — fetch one export.

    Args:
        client: Initialised :class:`~atlasent.AtlaSentClient`.
        org_id: AtlaSent organisation ID.
        export_id: UUID of the evidence export record.

    Returns:
        :class:`EvidenceExportRecord` dict with ``id``, ``org_id``,
        ``regime``, ``window_from``, ``window_to``, ``bundle``,
        ``bundle_sha256``, ``controls_total``, ``controls_evidenced``,
        ``controls_partial``, ``controls_missing``, ``generated_by``,
        and ``generated_at``.

    Raises:
        atlasent.exceptions.AtlaSentError: 404 when export not found.
    """
    return _do(
        client, "GET", f"/v1/orgs/{_enc(org_id)}/evidence-exports/{_enc(export_id)}"
    )


def create_evidence_export(
    client: AtlaSentClient,
    org_id: str,
    *,
    regime: RegimeId,
    window: dict[str, str] | None = None,
    bundle_id: str | None = None,
    evidence: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """``POST /v1/orgs/{orgId}/evidence-exports`` — build and
    persist an evidence bundle.

    Builds a canonical compliance envelope from engine-produced artifacts.
    The server defaults the time window to the 90 days preceding the
    request when ``window`` is not supplied.

    Args:
        client: Initialised :class:`~atlasent.AtlaSentClient`.
        org_id: AtlaSent organisation ID.
        regime: Compliance framework — ``"soc2_type_ii"``, ``"hipaa"``,
            or ``"gdpr"``.
        window: Optional time window dict with ``"from"`` and/or ``"to"``
            ISO-8601 timestamp strings.
        bundle_id: Optional deterministic bundle UUID. The server generates
            a random UUID when omitted.
        evidence: Optional free-form supplementary evidence dict. Keys may
            include ``"manual"``, ``"audit_log_slice"``,
            ``"policy_snapshot"``, and ``"permit_chain"``.

    Returns:
        Dict with ``export`` (:class:`EvidenceExportRecord`), ``bundle``
        (the canonical :class:`EvidenceBundle` envelope), and ``sha256``
        (hex digest of canonical bytes).

    Raises:
        ValueError: When ``regime`` is not a recognised value.
        atlasent.exceptions.AtlaSentError: 400 on server-side validation
            failure.
    """
    if regime not in _VALID_REGIMES:
        raise ValueError(f"regime must be one of: {', '.join(sorted(_VALID_REGIMES))}")

    body: dict[str, Any] = {"regime": regime}
    if window is not None:
        body["window"] = window
    if bundle_id is not None:
        body["bundle_id"] = bundle_id
    if evidence is not None:
        body.update(evidence)

    return _do(client, "POST", f"/v1/orgs/{_enc(org_id)}/evidence-exports", body)
