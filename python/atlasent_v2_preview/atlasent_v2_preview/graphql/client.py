"""GraphQL client — Python sibling of
``typescript/packages/v2-preview/src/graphql/client.ts``.

Pure GraphQL-over-HTTP backed by ``httpx.AsyncClient``. Hand-written
per PR #77's default plan; SDL codegen replaces or augments at v2 GA.

Design notes mirror the TS client:

  * Authorization, Content-Type, Accept, User-Agent, X-Request-ID
    headers are set by the client and cannot be overridden via the
    ``headers`` option — protects against accidental key leakage.
  * GraphQL-level errors (response 200 with ``errors`` populated) are
    returned in the response envelope, NOT raised. Transport / HTTP /
    parse failures raise :class:`GraphQLClientError`.
  * No introspection, no caching, no batching — those layer on top
    in customer code or at v2 GA.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from typing import Any, Literal

import httpx

from .types import (
    GraphQLClientOptions,
    GraphQLRequest,
    GraphQLResponse,
)

_SDK_VERSION = "2.0.0a0"

GraphQLClientErrorCode = Literal[
    "network",
    "timeout",
    "http_error",
    "parse_error",
    "invalid_response",
]


class GraphQLClientError(Exception):
    """Raised for transport / HTTP / parse failures.

    GraphQL-level errors (response 200 with ``errors`` populated) are
    NOT raised — they live in :attr:`GraphQLResponse.errors`.
    """

    def __init__(
        self,
        message: str,
        *,
        code: GraphQLClientErrorCode,
        status_code: int | None = None,
    ) -> None:
        super().__init__(message)
        self.code: GraphQLClientErrorCode = code
        self.status_code: int | None = status_code


def build_graphql_request(
    query: str,
    variables: Mapping[str, Any] | None = None,
    operation_name: str | None = None,
) -> GraphQLRequest:
    """Build a wire-shaped GraphQL request body.

    Exported for callers wiring their own HTTP transport. Raises
    :class:`GraphQLClientError` (``invalid_response``) on bad input
    so the caller boundary is consistent with the client itself.
    """
    if not isinstance(query, str) or not query:
        raise GraphQLClientError(
            "query must be a non-empty string",
            code="invalid_response",
        )
    out: dict[str, Any] = {"query": query}
    if variables is not None:
        out["variables"] = dict(variables)
    if operation_name is not None:
        out["operationName"] = operation_name
    return out  # type: ignore[return-value]


class GraphQLClient:
    """Hand-rolled GraphQL client for the v2 SDK preview.

    Single :meth:`query` method dispatches any document; callers
    carry their own response types via the generic.

    Example::

        from atlasent_v2_preview.graphql import GraphQLClient

        gql = GraphQLClient(
            endpoint="https://api.atlasent.io/v2/graphql",
            api_key="ask_live_...",
        )
        result = await gql.query(
            '''query Policies($filter: PolicyFilter) {
                 policies(filter: $filter) { id name active }
               }''',
            variables={"filter": {"active": True}},
        )
        if result.errors:
            for err in result.errors:
                ...
        else:
            ...result.data["policies"]

        await gql.close()  # or use async context manager
    """

    def __init__(
        self,
        *,
        endpoint: str,
        api_key: str,
        timeout: float = 10.0,
        headers: dict[str, str] | None = None,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        # Validate via the pydantic options model so all input checks
        # share one source of truth.
        opts = GraphQLClientOptions(
            endpoint=endpoint,
            api_key=api_key,
            timeout=timeout,
            headers=headers,
        )
        self._endpoint = opts.endpoint
        self._api_key = opts.api_key
        self._timeout = opts.timeout
        self._extra_headers: dict[str, str] = dict(opts.headers or {})
        # Allow tests / advanced callers to inject an httpx client
        # (sometimes wired with custom transport, retries, mock
        # transport, etc.). Default: create our own.
        self._client = client or httpx.AsyncClient(timeout=opts.timeout)
        self._owns_client = client is None

    async def query(
        self,
        query: str,
        variables: Mapping[str, Any] | None = None,
        operation_name: str | None = None,
    ) -> GraphQLResponse[dict[str, Any]]:
        """Execute a GraphQL operation.

        Returns the response envelope — ``data`` and ``errors`` may
        both be present per the spec. Raises
        :class:`GraphQLClientError` on transport / HTTP / parse
        failures.
        """
        body = build_graphql_request(query, variables, operation_name)

        request_id = uuid.uuid4().hex[:12]
        headers: dict[str, str] = {
            **self._extra_headers,
            # Locked headers — set last so they can't be overridden.
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self._api_key}",
            "User-Agent": f"atlasent-v2-preview/{_SDK_VERSION} graphql",
            "X-Request-ID": request_id,
        }

        try:
            response = await self._client.post(
                self._endpoint, json=body, headers=headers
            )
        except httpx.TimeoutException as err:
            raise GraphQLClientError(
                "Request to GraphQL endpoint timed out",
                code="timeout",
            ) from err
        except httpx.HTTPError as err:
            raise GraphQLClientError(
                f"Failed to reach GraphQL endpoint: {err}",
                code="network",
            ) from err

        if response.status_code >= 400:
            text = response.text[:200] if response.text else ""
            raise GraphQLClientError(
                f"GraphQL endpoint returned HTTP {response.status_code}"
                + (f": {text}" if text else ""),
                code="http_error",
                status_code=response.status_code,
            )

        try:
            parsed = response.json()
        except ValueError as err:
            raise GraphQLClientError(
                "Invalid JSON in GraphQL response body",
                code="parse_error",
                status_code=response.status_code,
            ) from err

        if not isinstance(parsed, dict):
            raise GraphQLClientError(
                "GraphQL response must be a JSON object",
                code="invalid_response",
                status_code=response.status_code,
            )

        # Spec doesn't require `data` to be present (errors-only is
        # valid), so we don't validate further here. Pydantic copes
        # with both shapes.
        return GraphQLResponse[dict[str, Any]].model_validate(parsed)

    async def close(self) -> None:
        """Close the underlying HTTP client (only if owned)."""
        if self._owns_client:
            await self._client.aclose()

    async def __aenter__(self) -> GraphQLClient:
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:  # noqa: ANN001
        await self.close()
