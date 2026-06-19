"""SIEM export configuration helpers (Wave E-2, enterprise plan).

Standalone functions that sit on top of an :class:`~atlasent.AtlaSentClient`
and call the SIEM export endpoints in ``atlasent-api``:

    GET   /v1/orgs/{orgId}/siem-config
    PATCH /v1/orgs/{orgId}/siem-config
    POST  /v1/orgs/{orgId}/siem-exports/test

All three endpoints require an **enterprise** plan. The API returns HTTP 402
when the plan gate blocks access; the SDK surfaces this as
:class:`~atlasent.exceptions.AtlaSentError` with ``status_code=402``.

Usage::

    from atlasent import AtlaSentClient
    from atlasent.siem import get_siem_config, upsert_siem_config, test_siem_delivery

    client = AtlaSentClient(api_key="...", base_url="...")
    config = upsert_siem_config(client, "org_abc",
        destination_url="https://splunk.acme.internal:8088/services/collector",
        format="splunk_hec",
        auth_type="bearer",
        credential="splunk-hec-token",
    )
    result = test_siem_delivery(client, "org_abc")
    print("delivery ok:", result["success"], "latency:", result.get("latencyMs"), "ms")
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any, Literal
from urllib.parse import quote

from .exceptions import AtlaSentError

if TYPE_CHECKING:
    from ._transport import SyncTransport

SiemFormat = Literal["splunk_hec", "elastic_ecs", "qradar_cef", "json"]
SiemAuthType = Literal["bearer", "basic", "api_key", "none"]

_VALID_FORMATS: frozenset[str] = frozenset(
    {"splunk_hec", "elastic_ecs", "qradar_cef", "json"}
)
_VALID_AUTH_TYPES: frozenset[str] = frozenset({"bearer", "basic", "api_key", "none"})


def _enc(value: str) -> str:
    return quote(value, safe="")


def _do(
    client: SyncTransport,
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
            msg or f"SIEM {method} {path} returned {response.status_code}",
            status_code=response.status_code,
            code="server_error" if response.status_code >= 500 else "bad_request",
            request_id=request_id,
        )
    try:
        return response.json()
    except ValueError as exc:
        raise AtlaSentError(
            f"SIEM {method} {path}: malformed JSON response",
            status_code=response.status_code,
            code="bad_response",
            request_id=request_id,
        ) from exc


def get_siem_config(client: SyncTransport, org_id: str) -> dict[str, Any]:
    """``GET /v1/orgs/{orgId}/siem-config`` — fetch current SIEM configuration.

    The ``credential`` field is never returned by the server (write-only).

    Args:
        client: Initialised :class:`~atlasent.AtlaSentClient`.
        org_id: AtlaSent organisation ID.

    Returns:
        SIEM config dict: ``orgId``, ``enabled``, ``destinationUrl``,
        ``format``, ``authType``, ``includedEventTypes``, ``batchSize``,
        ``retryCount``, ``updatedAt``, ``updatedBy``.

    Raises:
        atlasent.exceptions.AtlaSentError: 404 when not configured,
            402 when the org is not on the enterprise plan.
    """
    return _do(client, "GET", f"/v1/orgs/{_enc(org_id)}/siem-config")


def upsert_siem_config(
    client: SyncTransport,
    org_id: str,
    *,
    destination_url: str,
    format: SiemFormat = "json",
    auth_type: SiemAuthType = "none",
    credential: str | None = None,
    enabled: bool = True,
    included_event_types: list[str] | None = None,
    batch_size: int = 100,
    retry_count: int = 3,
) -> dict[str, Any]:
    """``PATCH /v1/orgs/{orgId}/siem-config`` — create or update SIEM config.

    Idempotent upsert. Pass ``credential`` to rotate the secret; omit it
    to keep the existing value.

    Args:
        client: Initialised :class:`~atlasent.AtlaSentClient`.
        org_id: AtlaSent organisation ID.
        destination_url: HTTPS endpoint that will receive events.
            Must start with ``https://``.
        format: Wire format — ``"splunk_hec"``, ``"elastic_ecs"``,
            ``"qradar_cef"``, or ``"json"``.
        auth_type: Auth method — ``"bearer"``, ``"basic"``,
            ``"api_key"``, or ``"none"``.
        credential: Write-only auth secret. Omit to keep existing value.
        enabled: Whether to stream events (default ``True``).
        included_event_types: Event types to stream. Defaults to
            ``["permit", "deny", "override", "governance"]``.
        batch_size: Events per delivery batch (1–1000, default 100).
        retry_count: Retry attempts on delivery failure (0–10, default 3).

    Returns:
        Saved SIEM config (credential omitted).

    Raises:
        ValueError: When ``format`` or ``auth_type`` is not a recognised value,
            ``destination_url`` does not start with ``https://``, or
            numeric bounds are violated.
        atlasent.exceptions.AtlaSentError: 400 on server-side validation
            failure, 402 when the org is not on the enterprise plan.
    """
    if not destination_url.startswith("https://"):
        raise ValueError("destination_url must be an HTTPS URL")
    if format not in _VALID_FORMATS:
        raise ValueError(f"format must be one of: {', '.join(sorted(_VALID_FORMATS))}")
    if auth_type not in _VALID_AUTH_TYPES:
        raise ValueError(
            f"auth_type must be one of: {', '.join(sorted(_VALID_AUTH_TYPES))}"
        )
    if not 1 <= batch_size <= 1000:
        raise ValueError(f"batch_size must be between 1 and 1000, got {batch_size}")
    if not 0 <= retry_count <= 10:
        raise ValueError(f"retry_count must be between 0 and 10, got {retry_count}")

    body: dict[str, Any] = {
        "destinationUrl": destination_url,
        "format": format,
        "authType": auth_type,
        "enabled": enabled,
        "includedEventTypes": included_event_types
        or ["permit", "deny", "override", "governance"],
        "batchSize": batch_size,
        "retryCount": retry_count,
    }
    if credential is not None:
        body["credential"] = credential

    return _do(client, "PATCH", f"/v1/orgs/{_enc(org_id)}/siem-config", body)


def siem_test_delivery(client: SyncTransport, org_id: str) -> dict[str, Any]:
    """``POST /v1/orgs/{orgId}/siem-exports/test`` — send a test event.

    Delivers a synthetic event to verify connectivity and authentication.

    Args:
        client: Initialised :class:`~atlasent.AtlaSentClient`.
        org_id: AtlaSent organisation ID.

    Returns:
        Dict with ``success`` (bool), ``latencyMs`` (int, optional),
        and ``error`` (str, optional on failure).

    Raises:
        atlasent.exceptions.AtlaSentError: 402 when not enterprise,
            409 when SIEM is not configured or not enabled for the org.
    """
    return _do(client, "POST", f"/v1/orgs/{_enc(org_id)}/siem-exports/test", {})
