"""SCIM 2.0 provisioning client — fluent sub-client interface.

This module exposes the same SCIM endpoints as ``atlasent.scim`` but
through a class-based sub-client pattern that mirrors the TypeScript
``client.scim.users.*`` surface:

    from atlasent import AtlaSentClient
    from atlasent.scim_client import ScimClient

    client = AtlaSentClient(api_key="...")
    scim = ScimClient(client)

    page = scim.users.list(org_id="org_abc")
    new_user = scim.users.create(org_id="org_abc", user={
        "userName": "alice@example.com",
        "active": True,
    })
    scim.users.delete(org_id="org_abc", user_id="usr_123")
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


def _qs(
    filter: str | None = None,  # noqa: A002
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


def _request(
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
            pass  # non-JSON error body — fall through to status-code message
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


class ScimUsersClient:
    """Sub-client for /scim/v2/{orgId}/Users operations."""

    def __init__(self, client: AtlaSentClient) -> None:
        self._client = client

    def list(
        self,
        org_id: str,
        *,
        filter: str | None = None,  # noqa: A002
        start_index: int | None = None,
        count: int | None = None,
    ) -> dict[str, Any]:
        """``GET /scim/v2/{orgId}/Users`` — list provisioned users.

        Args:
            org_id: AtlaSent organisation ID.
            filter: SCIM filter expression.
            start_index: 1-based pagination offset.
            count: Maximum results per page.

        Returns:
            SCIM ListResponse dict with ``totalResults`` and ``Resources``.
        """
        qs = _qs(filter=filter, start_index=start_index, count=count)
        return _request(self._client, "GET", f"/scim/v2/{_enc(org_id)}/Users{qs}")

    def create(
        self,
        org_id: str,
        user: dict[str, Any],
    ) -> dict[str, Any]:
        """``POST /scim/v2/{orgId}/Users`` — provision a new user.

        Args:
            org_id: AtlaSent organisation ID.
            user: SCIM User resource dict. ``schemas`` is injected
                automatically if absent.

        Returns:
            Created SCIM User resource with server-assigned ``id``.
        """
        if "schemas" not in user:
            user = {**user, "schemas": [SCIM_USER_SCHEMA]}
        return _request(self._client, "POST", f"/scim/v2/{_enc(org_id)}/Users", user)

    def update(
        self,
        org_id: str,
        user_id: str,
        user: dict[str, Any],
    ) -> dict[str, Any]:
        """``PUT /scim/v2/{orgId}/Users/{userId}`` — full replacement.

        Args:
            org_id: AtlaSent organisation ID.
            user_id: SCIM user ID to replace.
            user: Full SCIM User resource dict.

        Returns:
            Updated SCIM User resource.
        """
        if "schemas" not in user:
            user = {**user, "schemas": [SCIM_USER_SCHEMA]}
        return _request(
            self._client,
            "PUT",
            f"/scim/v2/{_enc(org_id)}/Users/{_enc(user_id)}",
            user,
        )

    def delete(
        self,
        org_id: str,
        user_id: str,
    ) -> None:
        """``DELETE /scim/v2/{orgId}/Users/{userId}`` — deprovision a user."""
        _request(
            self._client,
            "DELETE",
            f"/scim/v2/{_enc(org_id)}/Users/{_enc(user_id)}",
        )


class ScimGroupsClient:
    """Sub-client for /scim/v2/{orgId}/Groups operations."""

    def __init__(self, client: AtlaSentClient) -> None:
        self._client = client

    def list(
        self,
        org_id: str,
        *,
        filter: str | None = None,  # noqa: A002
        start_index: int | None = None,
        count: int | None = None,
    ) -> dict[str, Any]:
        """``GET /scim/v2/{orgId}/Groups`` — list provisioned groups."""
        qs = _qs(filter=filter, start_index=start_index, count=count)
        return _request(self._client, "GET", f"/scim/v2/{_enc(org_id)}/Groups{qs}")

    def create(
        self,
        org_id: str,
        group: dict[str, Any],
    ) -> dict[str, Any]:
        """``POST /scim/v2/{orgId}/Groups`` — create a group."""
        if "schemas" not in group:
            group = {**group, "schemas": [SCIM_GROUP_SCHEMA]}
        return _request(self._client, "POST", f"/scim/v2/{_enc(org_id)}/Groups", group)

    def delete(
        self,
        org_id: str,
        group_id: str,
    ) -> None:
        """``DELETE /scim/v2/{orgId}/Groups/{groupId}`` — delete a group."""
        _request(
            self._client,
            "DELETE",
            f"/scim/v2/{_enc(org_id)}/Groups/{_enc(group_id)}",
        )


class ScimClient:
    """Fluent SCIM 2.0 provisioning client.

    Mirrors the TypeScript ``client.scim.users.*`` / ``client.scim.groups.*``
    interface.

    Args:
        client: Initialised :class:`~atlasent.AtlaSentClient`.

    Usage::

        from atlasent import AtlaSentClient
        from atlasent.scim_client import ScimClient

        client = AtlaSentClient(api_key="...")
        scim = ScimClient(client)

        page = scim.users.list(org_id="org_abc")
    """

    def __init__(self, client: AtlaSentClient) -> None:
        self.users = ScimUsersClient(client)
        self.groups = ScimGroupsClient(client)
