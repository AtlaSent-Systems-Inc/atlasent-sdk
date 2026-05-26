"""SCIM 2.0 provisioning helpers (Wave E-1, RFC 7643/7644).

Standalone functions that sit on top of an :class:`~atlasent.AtlaSentClient`
and call the SCIM 2.0 endpoints in ``atlasent-api``:

    GET/POST  /v1/scim/v2/{orgId}/Users
    GET/PUT/PATCH/DELETE /v1/scim/v2/{orgId}/Users/{userId}
    GET/POST  /v1/scim/v2/{orgId}/Groups
    GET/PUT/PATCH/DELETE /v1/scim/v2/{orgId}/Groups/{groupId}

Usage::

    from atlasent import AtlaSentClient
    from atlasent.scim import scim_list_users, scim_create_user

    client = AtlaSentClient(api_key="...", base_url="...")
    result = scim_list_users(client, org_id="org_abc")
    for user in result["Resources"]:
        print(user["userName"])
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any
from urllib.parse import quote, urlencode

from .exceptions import AtlaSentError

if TYPE_CHECKING:
    from .client import AtlaSentClient

SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User"
SCIM_GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group"
SCIM_PATCH_OP_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp"


def _enc(value: str) -> str:
    return quote(value, safe="")


def _scim_qs(
    filter: str | None = None,
    start_index: int | None = None,
    count: int | None = None,
) -> str:
    params: dict[str, str] = {}
    if filter is not None:
        params["filter"] = filter
    if start_index is not None:
        params["startIndex"] = str(start_index)
    if count is not None:
        params["count"] = str(count)
    return ("?" + urlencode(params)) if params else ""


def _do(
    client: AtlaSentClient,
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    url = f"{client._base_url}{path}"  # noqa: SLF001
    kwargs: dict[str, Any] = {}
    if body is not None:
        kwargs["content"] = json.dumps(body, separators=(",", ":")).encode()
        kwargs["headers"] = {"Content-Type": "application/json"}
    response = client._client.request(method, url, **kwargs)  # noqa: SLF001
    request_id = response.headers.get("X-Request-ID")
    if response.status_code == 204:
        return None
    if response.status_code >= 400:
        msg = None
        try:
            err = response.json()
            msg = err.get("error") or err.get("message")
        except (ValueError, AttributeError):
            pass
        raise AtlaSentError(
            msg or f"SCIM {method} {path} returned {response.status_code}",
            status_code=response.status_code,
            code="server_error" if response.status_code >= 500 else "bad_request",
            request_id=request_id,
        )
    try:
        return response.json()
    except ValueError as exc:
        raise AtlaSentError(
            f"SCIM {method} {path}: malformed JSON response",
            status_code=response.status_code,
            code="bad_response",
            request_id=request_id,
        ) from exc


# ── Users ─────────────────────────────────────────────────────────────────────


def scim_list_users(
    client: AtlaSentClient,
    org_id: str,
    *,
    filter: str | None = None,
    start_index: int | None = None,
    count: int | None = None,
) -> dict[str, Any]:
    """``GET /v1/scim/v2/{orgId}/Users`` — list provisioned users.

    Args:
        client: Initialised :class:`~atlasent.AtlaSentClient`.
        org_id: AtlaSent organisation ID.
        filter: SCIM filter expression, e.g. ``userName eq "alice@example.com"``.
        start_index: 1-based pagination offset (default 1).
        count: Maximum results to return (default 100).

    Returns:
        SCIM ListResponse dict with ``totalResults`` and ``Resources``.
    """
    qs = _scim_qs(filter=filter, start_index=start_index, count=count)
    return _do(client, "GET", f"/v1/scim/v2/{_enc(org_id)}/Users{qs}")


def scim_create_user(
    client: AtlaSentClient,
    org_id: str,
    user: dict[str, Any],
) -> dict[str, Any]:
    """``POST /v1/scim/v2/{orgId}/Users`` — provision a new user.

    Args:
        client: Initialised :class:`~atlasent.AtlaSentClient`.
        org_id: AtlaSent organisation ID.
        user: SCIM User resource dict. Must include ``schemas`` and ``userName``.

    Returns:
        Created SCIM User resource with server-assigned ``id``.

    Raises:
        atlasent.exceptions.AtlaSentError: On 409 (duplicate ``userName``) or
            other non-2xx responses.
    """
    if "schemas" not in user:
        user = {**user, "schemas": [SCIM_USER_SCHEMA]}
    return _do(client, "POST", f"/v1/scim/v2/{_enc(org_id)}/Users", user)


def scim_get_user(
    client: AtlaSentClient,
    org_id: str,
    user_id: str,
) -> dict[str, Any]:
    """``GET /v1/scim/v2/{orgId}/Users/{userId}`` — fetch a user by ID."""
    return _do(client, "GET", f"/v1/scim/v2/{_enc(org_id)}/Users/{_enc(user_id)}")


def scim_replace_user(
    client: AtlaSentClient,
    org_id: str,
    user_id: str,
    user: dict[str, Any],
) -> dict[str, Any]:
    """``PUT /v1/scim/v2/{orgId}/Users/{userId}`` — full replacement."""
    if "schemas" not in user:
        user = {**user, "schemas": [SCIM_USER_SCHEMA]}
    return _do(client, "PUT", f"/v1/scim/v2/{_enc(org_id)}/Users/{_enc(user_id)}", user)


def scim_patch_user(
    client: AtlaSentClient,
    org_id: str,
    user_id: str,
    operations: list[dict[str, Any]],
) -> dict[str, Any]:
    """``PATCH /v1/scim/v2/{orgId}/Users/{userId}`` — partial update.

    Pass a list of RFC 7644 §3.5.2 PatchOp operations::

        scim_patch_user(client, org_id, user_id, [
            {"op": "replace", "path": "active", "value": False},
        ])
    """
    body = {"schemas": [SCIM_PATCH_OP_SCHEMA], "Operations": operations}
    return _do(
        client, "PATCH", f"/v1/scim/v2/{_enc(org_id)}/Users/{_enc(user_id)}", body
    )


def scim_delete_user(
    client: AtlaSentClient,
    org_id: str,
    user_id: str,
) -> None:
    """``DELETE /v1/scim/v2/{orgId}/Users/{userId}`` — deprovision a user."""
    _do(client, "DELETE", f"/v1/scim/v2/{_enc(org_id)}/Users/{_enc(user_id)}")


# ── Groups ────────────────────────────────────────────────────────────────────


def scim_list_groups(
    client: AtlaSentClient,
    org_id: str,
    *,
    filter: str | None = None,
    start_index: int | None = None,
    count: int | None = None,
) -> dict[str, Any]:
    """``GET /v1/scim/v2/{orgId}/Groups`` — list provisioned groups."""
    qs = _scim_qs(filter=filter, start_index=start_index, count=count)
    return _do(client, "GET", f"/v1/scim/v2/{_enc(org_id)}/Groups{qs}")


def scim_create_group(
    client: AtlaSentClient,
    org_id: str,
    group: dict[str, Any],
) -> dict[str, Any]:
    """``POST /v1/scim/v2/{orgId}/Groups`` — create a group."""
    if "schemas" not in group:
        group = {**group, "schemas": [SCIM_GROUP_SCHEMA]}
    return _do(client, "POST", f"/v1/scim/v2/{_enc(org_id)}/Groups", group)


def scim_get_group(
    client: AtlaSentClient,
    org_id: str,
    group_id: str,
) -> dict[str, Any]:
    """``GET /v1/scim/v2/{orgId}/Groups/{groupId}`` — fetch a group by ID."""
    return _do(client, "GET", f"/v1/scim/v2/{_enc(org_id)}/Groups/{_enc(group_id)}")


def scim_replace_group(
    client: AtlaSentClient,
    org_id: str,
    group_id: str,
    group: dict[str, Any],
) -> dict[str, Any]:
    """``PUT /v1/scim/v2/{orgId}/Groups/{groupId}`` — full replacement."""
    if "schemas" not in group:
        group = {**group, "schemas": [SCIM_GROUP_SCHEMA]}
    return _do(
        client, "PUT", f"/v1/scim/v2/{_enc(org_id)}/Groups/{_enc(group_id)}", group
    )


def scim_patch_group(
    client: AtlaSentClient,
    org_id: str,
    group_id: str,
    operations: list[dict[str, Any]],
) -> dict[str, Any]:
    """``PATCH /v1/scim/v2/{orgId}/Groups/{groupId}`` — add/remove members.

    Example — add a member::

        scim_patch_group(client, org_id, group_id, [
            {"op": "add", "path": "members",
             "value": [{"value": "user-id-abc", "display": "alice@example.com"}]},
        ])
    """
    body = {"schemas": [SCIM_PATCH_OP_SCHEMA], "Operations": operations}
    return _do(
        client, "PATCH", f"/v1/scim/v2/{_enc(org_id)}/Groups/{_enc(group_id)}", body
    )


def scim_delete_group(
    client: AtlaSentClient,
    org_id: str,
    group_id: str,
) -> None:
    """``DELETE /v1/scim/v2/{orgId}/Groups/{groupId}`` — delete a group."""
    _do(client, "DELETE", f"/v1/scim/v2/{_enc(org_id)}/Groups/{_enc(group_id)}")
