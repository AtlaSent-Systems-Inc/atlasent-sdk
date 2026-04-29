"""GraphQL client test suite — Python sibling of
``typescript/packages/v2-preview/test/graphql.test.ts``.

Strategy: ``httpx.MockTransport`` lets us inject fake request
handlers per test without standing up a real server. Same scenario
matrix as the TS tests so cross-language parity is locked.
"""

from __future__ import annotations

import json

import httpx
import pytest

from atlasent_v2_preview.graphql import (
    GraphQLClient,
    GraphQLClientError,
    GraphQLResponse,
    build_graphql_request,
)

pytestmark = pytest.mark.asyncio


# ── Helpers ──────────────────────────────────────────────────────────


def make_client(handler, **overrides) -> GraphQLClient:
    """Construct a GraphQLClient backed by an httpx MockTransport."""
    transport = httpx.MockTransport(handler)
    httpx_client = httpx.AsyncClient(transport=transport)
    return GraphQLClient(
        endpoint="https://api.atlasent.io/v2/graphql",
        api_key="ask_live_test",
        client=httpx_client,
        **overrides,
    )


def json_response(body: dict, status: int = 200) -> httpx.Response:
    return httpx.Response(
        status_code=status,
        headers={"Content-Type": "application/json"},
        content=json.dumps(body).encode("utf-8"),
    )


# ── build_graphql_request ────────────────────────────────────────────


class TestBuildRequest:
    async def test_just_query(self):
        body = build_graphql_request("query { policies { id } }")
        assert body == {"query": "query { policies { id } }"}
        assert "variables" not in body
        assert "operationName" not in body

    async def test_with_variables(self):
        query = (
            "query Policies($filter: PolicyFilter) "
            "{ policies(filter: $filter) { id } }"
        )
        body = build_graphql_request(
            query,
            variables={"filter": {"active": True}},
        )
        assert body["variables"] == {"filter": {"active": True}}

    async def test_with_operation_name(self):
        body = build_graphql_request(
            "query Policies { policies { id } }",
            operation_name="Policies",
        )
        assert body["operationName"] == "Policies"
        assert "variables" not in body

    async def test_rejects_empty_query(self):
        with pytest.raises(GraphQLClientError) as excinfo:
            build_graphql_request("")
        assert excinfo.value.code == "invalid_response"

    async def test_rejects_non_string_query(self):
        with pytest.raises(GraphQLClientError):
            build_graphql_request(None)  # type: ignore[arg-type]


# ── Constructor validation ───────────────────────────────────────────


class TestConstructor:
    async def test_rejects_empty_endpoint(self):
        with pytest.raises(Exception):
            GraphQLClient(endpoint="", api_key="k")

    async def test_rejects_empty_api_key(self):
        with pytest.raises(Exception):
            GraphQLClient(endpoint="https://x", api_key="")


# ── Wire shape ───────────────────────────────────────────────────────


class TestWireShape:
    async def test_posts_json_to_endpoint(self):
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["url"] = str(request.url)
            captured["method"] = request.method
            captured["body"] = json.loads(request.content)
            return json_response({"data": {"policies": [{"id": "p1"}]}})

        client = make_client(handler)
        result = await client.query(
            "query { policies { id } }",
            variables={"active": True},
            operation_name="Policies",
        )
        assert captured["url"] == "https://api.atlasent.io/v2/graphql"
        assert captured["method"] == "POST"
        assert captured["body"] == {
            "query": "query { policies { id } }",
            "variables": {"active": True},
            "operationName": "Policies",
        }
        assert result.data == {"policies": [{"id": "p1"}]}
        assert result.errors is None
        await client.close()

    async def test_sets_locked_headers(self):
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["headers"] = dict(request.headers)
            return json_response({"data": None})

        client = make_client(handler)
        await client.query("query { _ }")
        h = captured["headers"]
        assert h["authorization"] == "Bearer ask_live_test"
        assert h["content-type"] == "application/json"
        assert h["accept"] == "application/json"
        assert "atlasent-v2-preview" in h["user-agent"]
        assert "graphql" in h["user-agent"]
        # X-Request-ID is a 12-hex correlation id.
        assert len(h["x-request-id"]) == 12
        await client.close()

    async def test_merges_custom_headers_locked_ones_win(self):
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["headers"] = dict(request.headers)
            return json_response({"data": None})

        client = make_client(
            handler,
            headers={
                "X-Tenant-Id": "tenant-1",
                "Authorization": "Bearer impostor",
            },
        )
        await client.query("query { _ }")
        h = captured["headers"]
        assert h["x-tenant-id"] == "tenant-1"
        # Locked header wins — protects against accidental key leakage.
        assert h["authorization"] == "Bearer ask_live_test"
        await client.close()


# ── Response handling ────────────────────────────────────────────────


class TestResponseHandling:
    async def test_returns_errors_in_envelope_not_raised(self):
        def handler(_: httpx.Request) -> httpx.Response:
            return json_response(
                {
                    "data": None,
                    "errors": [
                        {
                            "message": "Policy not found",
                            "path": ["policies", 0],
                            "extensions": {"code": "NOT_FOUND"},
                        }
                    ],
                }
            )

        client = make_client(handler)
        result = await client.query("query { _ }")
        assert result.data is None
        assert result.errors is not None
        assert len(result.errors) == 1
        assert result.errors[0].message == "Policy not found"
        assert result.errors[0].extensions == {"code": "NOT_FOUND"}
        assert result.errors[0].path == ["policies", 0]
        await client.close()

    async def test_supports_partial_success(self):
        def handler(_: httpx.Request) -> httpx.Response:
            return json_response(
                {
                    "data": {"policies": [{"id": "p1"}]},
                    "errors": [{"message": "warning: 1 redacted"}],
                }
            )

        client = make_client(handler)
        result = await client.query("query { _ }")
        assert result.data == {"policies": [{"id": "p1"}]}
        assert result.errors is not None
        assert len(result.errors) == 1
        await client.close()

    async def test_preserves_extensions(self):
        def handler(_: httpx.Request) -> httpx.Response:
            return json_response(
                {"data": None, "extensions": {"tracing": {"duration": 42}}}
            )

        client = make_client(handler)
        result = await client.query("query { _ }")
        assert result.extensions == {"tracing": {"duration": 42}}
        await client.close()


# ── Error taxonomy ───────────────────────────────────────────────────


class TestErrorTaxonomy:
    async def test_http_error_4xx(self):
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(
                400,
                content=b"bad request",
                headers={"Content-Type": "text/plain"},
            )

        client = make_client(handler)
        with pytest.raises(GraphQLClientError) as excinfo:
            await client.query("query { _ }")
        assert excinfo.value.code == "http_error"
        assert excinfo.value.status_code == 400
        await client.close()

    async def test_http_error_5xx(self):
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(503, content=b"upstream")

        client = make_client(handler)
        with pytest.raises(GraphQLClientError) as excinfo:
            await client.query("query { _ }")
        assert excinfo.value.code == "http_error"
        assert excinfo.value.status_code == 503
        await client.close()

    async def test_parse_error_on_non_json_200(self):
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                content=b"not json at all",
                headers={"Content-Type": "application/json"},
            )

        client = make_client(handler)
        with pytest.raises(GraphQLClientError) as excinfo:
            await client.query("query { _ }")
        assert excinfo.value.code == "parse_error"
        await client.close()

    async def test_invalid_response_when_body_not_object(self):
        def handler(_: httpx.Request) -> httpx.Response:
            return json_response([1, 2, 3])  # type: ignore[arg-type]

        client = make_client(handler)
        with pytest.raises(GraphQLClientError) as excinfo:
            await client.query("query { _ }")
        assert excinfo.value.code == "invalid_response"
        await client.close()

    async def test_network_error(self):
        def handler(_: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("ECONNREFUSED")

        client = make_client(handler)
        with pytest.raises(GraphQLClientError) as excinfo:
            await client.query("query { _ }")
        assert excinfo.value.code == "network"
        await client.close()

    async def test_timeout(self):
        def handler(_: httpx.Request) -> httpx.Response:
            raise httpx.ReadTimeout("timed out")

        client = make_client(handler)
        with pytest.raises(GraphQLClientError) as excinfo:
            await client.query("query { _ }")
        assert excinfo.value.code == "timeout"
        await client.close()


# ── Lifecycle ────────────────────────────────────────────────────────


class TestLifecycle:
    async def test_async_context_manager(self):
        def handler(_: httpx.Request) -> httpx.Response:
            return json_response({"data": None})

        async with make_client(handler) as gql:
            result = await gql.query("query { _ }")
            assert isinstance(result, GraphQLResponse)

    async def test_does_not_close_injected_client(self):
        # When the caller injects their own httpx client, we don't
        # close it — they own the lifecycle.
        captured = {"closed": False}

        class Tracking(httpx.AsyncClient):
            async def aclose(self):
                captured["closed"] = True
                await super().aclose()

        outer = Tracking(transport=httpx.MockTransport(lambda r: json_response({})))
        client = GraphQLClient(
            endpoint="https://x", api_key="k", client=outer
        )
        await client.close()
        assert captured["closed"] is False
        await outer.aclose()
