"""Auth helpers — token management and multi-IdP token refresh.

Wire surface: /v1/auth/* endpoints in atlasent-api.

Usage::

    from atlasent import AtlaSentClient
    from atlasent.auth import (
        refresh_token,
        refresh_with_idp,
        list_idp_connections,
    )

    client = AtlaSentClient(api_key="...")

    # Refresh using the default IdP connection
    tokens = refresh_token(client, current_refresh_token)

    # Refresh using a specific IdP (multi-IdP orgs)
    tokens = refresh_with_idp(client, idp_id="idp_okta_prod",
                               refresh_token=current_refresh_token)

    # List available IdP connections for this org
    connections = list_idp_connections(client)
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any
from urllib.parse import quote

from .exceptions import AtlaSentError

if TYPE_CHECKING:
    from .client import AtlaSentClient


def _post(
    client: AtlaSentClient,
    path: str,
    body: dict[str, Any],
) -> dict[str, Any]:
    """POST helper — raises AtlaSentError on non-2xx."""
    url = f"{client._base_url}{path}"  # noqa: SLF001
    response = client._client.request(  # noqa: SLF001
        "POST",
        url,
        content=json.dumps(body, separators=(",", ":")).encode(),
        headers={"Content-Type": "application/json"},
    )
    request_id = response.headers.get("X-Request-ID")
    if response.status_code >= 400:
        msg = None
        try:
            err = response.json()
            msg = err.get("error") or err.get("message")
        except (ValueError, AttributeError):
            pass  # non-JSON error body — fall through to status-code message
        raise AtlaSentError(
            msg or f"POST {path} returned {response.status_code}",
            status_code=response.status_code,
            code="server_error" if response.status_code >= 500 else "bad_request",
            request_id=request_id,
        )
    try:
        return response.json()
    except ValueError as exc:
        raise AtlaSentError(
            f"POST {path}: malformed JSON response",
            status_code=response.status_code,
            code="bad_response",
            request_id=request_id,
        ) from exc


def _get(
    client: AtlaSentClient,
    path: str,
) -> dict[str, Any]:
    """GET helper — raises AtlaSentError on non-2xx."""
    url = f"{client._base_url}{path}"  # noqa: SLF001
    response = client._client.get(url)  # noqa: SLF001
    request_id = response.headers.get("X-Request-ID")
    if response.status_code >= 400:
        msg = None
        try:
            err = response.json()
            msg = err.get("error") or err.get("message")
        except (ValueError, AttributeError):
            pass  # non-JSON error body — fall through to status-code message
        raise AtlaSentError(
            msg or f"GET {path} returned {response.status_code}",
            status_code=response.status_code,
            code="server_error" if response.status_code >= 500 else "bad_request",
            request_id=request_id,
        )
    try:
        return response.json()
    except ValueError as exc:
        raise AtlaSentError(
            f"GET {path}: malformed JSON response",
            status_code=response.status_code,
            code="bad_response",
            request_id=request_id,
        ) from exc


def refresh_token(
    client: AtlaSentClient,
    refresh_token: str,  # noqa: A002
) -> dict[str, Any]:
    """``POST /v1/auth/token/refresh`` — refresh using the default IdP.

    Args:
        client: Initialised :class:`~atlasent.AtlaSentClient`.
        refresh_token: The current refresh token.

    Returns:
        Token response dict with ``access_token``, ``refresh_token``,
        ``token_type``, and ``expires_in``.

    Raises:
        atlasent.exceptions.AtlaSentError: On 401 (invalid token) or
            other non-2xx responses.
    """
    return _post(
        client,
        "/v1/auth/token/refresh",
        {
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        },
    )


def refresh_with_idp(
    client: AtlaSentClient,
    idp_id: str,
    refresh_token: str,  # noqa: A002
) -> dict[str, Any]:
    """Refresh an access token against a specific IdP connection.

    Use this in multi-IdP organisations where the caller needs to
    specify which SSO connection to use for the token exchange.

    Wire: ``POST /v1/auth/idp/{idpId}/token/refresh``

    Args:
        client: Initialised :class:`~atlasent.AtlaSentClient`.
        idp_id: IdP connection ID (e.g. ``"idp_okta_prod"``, ``"idp_entra"``).
            Call :func:`list_idp_connections` to discover valid IDs.
        refresh_token: The current refresh token.

    Returns:
        Token response dict with ``access_token``, ``refresh_token``,
        ``token_type``, ``expires_in``, and ``idp_id``.

    Raises:
        atlasent.exceptions.AtlaSentError: On 401 (invalid token or
            unknown IdP) or other non-2xx responses.
    """
    if not idp_id:
        raise AtlaSentError("idp_id is required", code="bad_request")
    path = f"/v1/auth/idp/{quote(idp_id, safe='')}/token/refresh"
    return _post(
        client,
        path,
        {
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
            "idp_id": idp_id,
        },
    )


def list_idp_connections(
    client: AtlaSentClient,
) -> list[dict[str, Any]]:
    """``GET /v1/auth/idp-connections`` — list IdP connections for this org.

    Args:
        client: Initialised :class:`~atlasent.AtlaSentClient`.

    Returns:
        List of IdP connection dicts, each with at least ``id``, ``name``,
        ``provider``, ``enabled``, ``default``, and ``created_at``.
    """
    data = _get(client, "/v1/auth/idp-connections")
    return data.get("connections", [])
