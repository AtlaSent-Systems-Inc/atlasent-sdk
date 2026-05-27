"""Tests for atlasent.evidence_bundle helpers."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from atlasent.evidence_bundle import (
    create_evidence_bundle,
    download_evidence_bundle,
    get_evidence_bundle,
)
from atlasent.exceptions import AtlaSentError


def _make_response(
    status_code: int,
    body: object,
    *,
    raw: bytes = b"",
    headers: dict | None = None,
) -> MagicMock:
    resp = MagicMock()
    resp.status_code = status_code
    resp.headers = headers or {}
    resp.json.return_value = body
    resp.content = raw
    return resp


def _make_client(response: MagicMock) -> MagicMock:
    client = MagicMock()
    client._base_url = "https://api.atlasent.io"
    http = MagicMock()
    http.request.return_value = response
    client._client = http
    return client


STUB_BUNDLE = {
    "bundle_id": "bnd_abc",
    "org_id": "org_xyz",
    "incident_id": "inc_123",
    "status": "pending",
    "included_permits": [],
    "include_overrides": False,
    "format": "json",
    "created_at": "2026-01-01T00:00:00Z",
    "expires_at": "2026-01-08T00:00:00Z",
}


# ── create_evidence_bundle ────────────────────────────────────────────────────


def test_create_posts_to_correct_path() -> None:
    resp = _make_response(200, STUB_BUNDLE)
    client = _make_client(resp)
    result = create_evidence_bundle(client, incident_id="inc_123")
    url = client._client.request.call_args[0][1]
    assert url.endswith("/v1/evidence-bundles")
    assert result["bundle_id"] == "bnd_abc"


def test_create_sends_incident_id() -> None:
    import json as _json

    resp = _make_response(200, STUB_BUNDLE)
    client = _make_client(resp)
    create_evidence_bundle(client, incident_id="inc_123")
    body = _json.loads(client._client.request.call_args[1]["content"])
    assert body["incident_id"] == "inc_123"


def test_create_sends_optional_fields() -> None:
    import json as _json

    resp = _make_response(200, STUB_BUNDLE)
    client = _make_client(resp)
    create_evidence_bundle(
        client,
        incident_id="inc_123",
        included_permits=["pt_1"],
        include_overrides=True,
    )
    body = _json.loads(client._client.request.call_args[1]["content"])
    assert body["included_permits"] == ["pt_1"]
    assert body["include_overrides"] is True


def test_create_raises_on_400() -> None:
    resp = _make_response(400, {"error": "bad_request"})
    client = _make_client(resp)
    with pytest.raises(AtlaSentError) as exc_info:
        create_evidence_bundle(client, incident_id="inc_123")
    assert exc_info.value.code == "bad_request"


def test_create_raises_on_500() -> None:
    resp = _make_response(500, {})
    client = _make_client(resp)
    with pytest.raises(AtlaSentError) as exc_info:
        create_evidence_bundle(client, incident_id="inc_123")
    assert exc_info.value.code == "server_error"


def test_create_raises_on_malformed_json() -> None:
    resp = _make_response(200, None)
    resp.json.side_effect = ValueError("bad json")
    client = _make_client(resp)
    with pytest.raises(AtlaSentError):
        create_evidence_bundle(client, incident_id="inc_123")


# ── get_evidence_bundle ───────────────────────────────────────────────────────


def test_get_calls_correct_path() -> None:
    resp = _make_response(200, STUB_BUNDLE)
    client = _make_client(resp)
    result = get_evidence_bundle(client, "bnd_abc")
    url = client._client.request.call_args[0][1]
    assert "/v1/evidence-bundles/bnd_abc" in url
    assert result["bundle_id"] == "bnd_abc"


def test_get_url_encodes_bundle_id() -> None:
    resp = _make_response(200, STUB_BUNDLE)
    client = _make_client(resp)
    get_evidence_bundle(client, "bnd/special")
    url = client._client.request.call_args[0][1]
    assert "bnd%2Fspecial" in url


def test_get_raises_on_404() -> None:
    resp = _make_response(404, {"error": "not_found"})
    client = _make_client(resp)
    with pytest.raises(AtlaSentError):
        get_evidence_bundle(client, "bnd_missing")


# ── download_evidence_bundle ──────────────────────────────────────────────────


def test_download_returns_bytes() -> None:
    resp = _make_response(200, None, raw=b"%PDF-1.4 content")
    client = _make_client(resp)
    result = download_evidence_bundle(client, "bnd_abc", format="pdf")
    assert isinstance(result, bytes)
    assert result == b"%PDF-1.4 content"


def test_download_default_format_is_json() -> None:
    resp = _make_response(200, None, raw=b"{}")
    client = _make_client(resp)
    download_evidence_bundle(client, "bnd_abc")
    url = client._client.request.call_args[0][1]
    assert "format=json" in url


def test_download_passes_pdf_format() -> None:
    resp = _make_response(200, None, raw=b"PDF")
    client = _make_client(resp)
    download_evidence_bundle(client, "bnd_abc", format="pdf")
    url = client._client.request.call_args[0][1]
    assert "format=pdf" in url


def test_download_url_encodes_bundle_id() -> None:
    resp = _make_response(200, None, raw=b"data")
    client = _make_client(resp)
    download_evidence_bundle(client, "bnd/abc", format="json")
    url = client._client.request.call_args[0][1]
    assert "bnd%2Fabc" in url


def test_download_raises_on_error() -> None:
    resp = _make_response(403, {"error": "forbidden"})
    client = _make_client(resp)
    with pytest.raises(AtlaSentError):
        download_evidence_bundle(client, "bnd_abc")
