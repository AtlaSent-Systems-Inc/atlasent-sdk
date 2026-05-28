"""Evidence Bundle helpers — create, retrieve, and download compliance
evidence bundles for incident investigations and audit export.

Wire surface: POST/GET /v1/evidence-bundles

Usage::

    from atlasent import AtlaSentClient
    from atlasent.evidence_bundle import (
        create_evidence_bundle,
        get_evidence_bundle,
        download_evidence_bundle,
    )

    client = AtlaSentClient(api_key="...")

    bundle = create_evidence_bundle(
        client, incident_id="inc_abc123", include_overrides=True
    )
    same_bundle = get_evidence_bundle(client, bundle["bundle_id"])
    pdf_bytes = download_evidence_bundle(client, bundle["bundle_id"], format="pdf")
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any
from urllib.parse import quote, urlencode

from .exceptions import AtlaSentError

if TYPE_CHECKING:
    from .client import AtlaSentClient


def _do(
    client: AtlaSentClient,
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
    *,
    raw: bool = False,
) -> dict[str, Any] | bytes | None:
    """Execute an HTTP request against the AtlaSent API.

    Args:
        client: Initialised :class:`~atlasent.AtlaSentClient`.
        method: HTTP method (GET, POST, etc.).
        path: Path relative to ``client._base_url``.
        body: Optional request body (JSON-serialised).
        raw: When *True* return the raw response bytes instead of parsed JSON.
    """
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
            pass  # non-JSON error body — fall through to status-code message
        raise AtlaSentError(
            msg or f"{method} {path} returned {response.status_code}",
            status_code=response.status_code,
            code="server_error" if response.status_code >= 500 else "bad_request",
            request_id=request_id,
        )
    if raw:
        return response.content
    if response.status_code == 204:
        return None
    try:
        return response.json()
    except ValueError as exc:
        raise AtlaSentError(
            f"{method} {path}: malformed JSON response",
            status_code=response.status_code,
            code="bad_response",
            request_id=request_id,
        ) from exc


def create_evidence_bundle(
    client: AtlaSentClient,
    incident_id: str,
    *,
    included_permits: list[str] | None = None,
    include_overrides: bool = False,
) -> dict[str, Any]:
    """``POST /v1/evidence-bundles`` — create a new evidence bundle.

    Args:
        client: Initialised :class:`~atlasent.AtlaSentClient`.
        incident_id: Incident or investigation ID for this bundle.
        included_permits: Optional list of specific permit IDs to include.
            When omitted, all permits associated with the incident are
            included.
        include_overrides: When *True*, override events are embedded in
            the bundle. Defaults to *False*.

    Returns:
        Evidence bundle dict with at least ``bundle_id``, ``org_id``,
        ``incident_id``, ``status``, and ``created_at``.
    """
    payload: dict[str, Any] = {"incident_id": incident_id}
    if included_permits is not None:
        payload["included_permits"] = included_permits
    if include_overrides:
        payload["include_overrides"] = include_overrides
    return _do(client, "POST", "/v1/evidence-bundles", payload)


def get_evidence_bundle(
    client: AtlaSentClient,
    bundle_id: str,
) -> dict[str, Any]:
    """``GET /v1/evidence-bundles/{bundleId}`` — retrieve a bundle by ID.

    Args:
        client: Initialised :class:`~atlasent.AtlaSentClient`.
        bundle_id: The bundle ID to retrieve.

    Returns:
        Evidence bundle dict.

    Raises:
        atlasent.exceptions.AtlaSentError: On 404 (not found) or other
            non-2xx responses.
    """
    if not bundle_id:
        raise AtlaSentError("bundle_id is required", code="bad_request")
    path = f"/v1/evidence-bundles/{quote(bundle_id, safe='')}"
    return _do(client, "GET", path)


def download_evidence_bundle(
    client: AtlaSentClient,
    bundle_id: str,
    *,
    format: str = "json",  # noqa: A002
) -> bytes:
    """``GET /v1/evidence-bundles/{bundleId}/download`` — download a bundle.

    Args:
        client: Initialised :class:`~atlasent.AtlaSentClient`.
        bundle_id: The bundle to download.
        format: ``"json"`` (default) or ``"pdf"``.

    Returns:
        Raw bytes of the downloaded bundle file.

    Raises:
        atlasent.exceptions.AtlaSentError: On 404 (not found), 404 when
            the bundle is not yet ``ready``, or other non-2xx responses.
    """
    if not bundle_id:
        raise AtlaSentError("bundle_id is required", code="bad_request")
    qs = urlencode({"format": format})
    path = f"/v1/evidence-bundles/{quote(bundle_id, safe='')}/download?{qs}"
    result = _do(client, "GET", path, raw=True)
    return result  # type: ignore[return-value]


class EvidenceBundlesClient:
    """Sub-client for evidence bundle operations on ``AtlaSentClient``.

    Access via ``client.evidence_bundles``::

        client = AtlaSentClient(api_key="...")
        bundles = client.evidence_bundles.list()
        bundle  = client.evidence_bundles.create("inc_abc123")
        pdf     = client.evidence_bundles.download(bundle["bundle_id"], format="pdf")
    """

    def __init__(self, client: AtlaSentClient) -> None:
        self._client = client

    def list(
        self,
        *,
        execution_id: str | None = None,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        """``GET /v1/evidence-bundles`` — list bundles for the org."""
        params: dict[str, str] = {}
        if execution_id is not None:
            params["execution_id"] = execution_id
        if limit is not None:
            params["limit"] = str(limit)
        if cursor is not None:
            params["cursor"] = cursor
        qs = ("?" + urlencode(params)) if params else ""
        return _do(self._client, "GET", f"/v1/evidence-bundles{qs}")  # type: ignore[return-value]

    def create(
        self,
        incident_id: str,
        *,
        included_permits: list[str] | None = None,
        include_overrides: bool = False,
    ) -> dict[str, Any]:
        """``POST /v1/evidence-bundles`` — create a new evidence bundle."""
        return create_evidence_bundle(
            self._client,
            incident_id,
            included_permits=included_permits,
            include_overrides=include_overrides,
        )  # type: ignore[return-value]

    def get(self, bundle_id: str) -> dict[str, Any]:
        """``GET /v1/evidence-bundles/{id}`` — retrieve a bundle by ID."""
        return get_evidence_bundle(self._client, bundle_id)  # type: ignore[return-value]

    def download(self, bundle_id: str, *, format: str = "json") -> bytes:  # noqa: A002
        """``GET /v1/evidence-bundles/{id}/download`` — download bundle bytes."""
        return download_evidence_bundle(self._client, bundle_id, format=format)
