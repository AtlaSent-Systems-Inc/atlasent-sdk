"""GraphQL wire-shape types — Python sibling of
``typescript/packages/v2-preview/src/graphql/types.ts``.

Pydantic models for parsed responses; TypedDict for the request body
so callers can compose it with plain dicts. Held in v2-preview while
the GraphQL endpoint shape stabilises in ``atlasent-api``.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, Generic, TypeVar

from pydantic import BaseModel, Field
from typing_extensions import NotRequired, TypedDict

T = TypeVar("T")


class GraphQLRequest(TypedDict):
    """GraphQL request body posted to the endpoint."""

    query: str
    variables: NotRequired[Mapping[str, Any]]
    operationName: NotRequired[str]


class GraphQLError(BaseModel):
    """One error in a GraphQL response.

    Per spec ``message`` is required; everything else is informational.
    """

    message: str
    path: list[str | int] | None = None
    """Path through the response data where the error occurred."""

    locations: list[dict[str, int]] | None = None
    """Source positions in the query document."""

    extensions: dict[str, Any] | None = None
    """Server-defined error metadata — e.g. ``{"code": "FORBIDDEN"}``."""

    model_config = {"extra": "allow"}


class GraphQLResponse(BaseModel, Generic[T]):
    """GraphQL response envelope.

    ``data`` and ``errors`` are independent — a query can succeed
    partially with both populated. Spec-wise:

      * ``data: None`` + ``errors: [...]`` → query completely failed
      * ``data: {...}`` + ``errors: [...]`` → partial success
      * ``data: {...}`` + no ``errors``     → fully successful
    """

    data: T | None = None
    errors: list[GraphQLError] | None = None
    extensions: dict[str, Any] | None = None
    """Server-defined extensions (timing, tracing, etc.)."""

    model_config = {"extra": "allow"}


class GraphQLClientOptions(BaseModel):
    """Constructor options for :class:`GraphQLClient`.

    Pydantic model so callers can validate from config files
    (TOML / YAML / env-driven dicts) without writing extra glue.
    """

    endpoint: str = Field(min_length=1)
    api_key: str = Field(min_length=1)
    timeout: float = 10.0
    """Per-request timeout in seconds. Defaults to 10."""

    headers: dict[str, str] | None = None
    """Extra HTTP headers added to every request.

    ``Authorization`` / ``Content-Type`` / ``Accept`` are set by the
    client and cannot be overridden via this map.
    """

    model_config = {"extra": "forbid"}


# Convenience aliases callers don't need but tests / docs do.
GraphQLVariables = Mapping[str, Any]
GraphQLPath = Sequence[str | int]
