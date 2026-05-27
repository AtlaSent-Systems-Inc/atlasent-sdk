"""Tests for atlasent.evidence_bundle — create, get, download helpers."""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import httpx
import pytest

from atlasent import AtlaSentClient
from atlasent.evidence_bundle import (
    create_evidence_bundle,
    download_evidence_bundle,
    get_evidence_bundle,
)
from atlasent.exceptions import AtlaSentError

API_KEY = "ask_test_evidence_bundle"
BASE_URL = "https://api.atlasent.io"


def _client() -> AtlaSentClient:
    return AtlaSentClient(api_key=API_KEY, base_url=BASE_URL)


def _mock_response(body: object, status: int = 200) -> MagicMock:
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status
    resp.headers = {"X-Request-ID": "req-test-123"}
    if body is not None and not isinstance(body, bytes):
        resp.json = MagicMock(return_value=body)
        resp.content = json.dumps(body).encode()
    else:
        resp.json = MagicMock(side_effect=ValueError("no json"))
        resp.content = body if isinstance(body, bytes) else b""
    return resp


SAMPLE_BUNDLE = {
    "bundle_id": "bundle_abc123",
    "org_id": "org_test",
    "incident_id": "inc_001",
    "status": "ready",
    "created_at": "2026-05-27T12:00:00Z",
}


class TestCreateEvidenceBundle:
    def test_create_minimal(self):
        client = _client()
        with patch.object(
            client._client,
            "request",
            return_value=_mock_response(SAMPLE_BUNDLE, 201),
        ) as mock_req:
            result = create_evidence_bundle(client, "inc_001")
        assert result["bundle_id"] == "bundle_abc123"
        assert mock_req.call_args[0][0] == "POST"
        sent = json.loads(mock_req.call_args[1]["content"])
        assert sent["incident_id"] == "inc_001"
        assert "included_permits" not in sent
        assert "include_overrides" not in sent

    def test_create_with_permits_and_overrides(self):
        client = _client()
        with patch.object(
            client._client,
            "request",
            return_value=_mock_response(SAMPLE_BUNDLE, 201),
        ) as mock_req:
            create_evidence_bundle(
                client,
                "inc_001",
                included_permits=["permit_a", "permit_b"],
                include_overrides=True,
            )
        sent = json.loads(mock_req.call_args[1]["content"])
        assert sent["included_permits"] == ["permit_a", "permit_b"]
        assert sent["include_overrides"] is True

    def test_create_400_raises(self):
        client = _client()
        with patch.object(
            client._client,
            "request",
            return_value=_mock_response({"error": "bad request"}, 400),
        ):
            with pytest.raises(AtlaSentError) as exc_info:
                create_evidence_bundle(client, "")
        assert exc_info.value.status_code == 400

    def test_create_500_raises(self):
        client = _client()
        with patch.object(
            client._client,
            "request",
            return_value=_mock_response({"message": "internal error"}, 500),
        ):
            with pytest.raises(AtlaSentError) as exc_info:
                create_evidence_bundle(client, "inc_001")
        assert exc_info.value.status_code == 500

    def test_create_malformed_json_raises(self):
        client = _client()
        resp = MagicMock(spec=httpx.Response)
        resp.status_code = 200
        resp.headers = {"X-Request-ID": "req-123"}
        resp.json = MagicMock(side_effect=ValueError("bad json"))
        with patch.object(client._client, "request", return_value=resp):
            with pytest.raises(AtlaSentError) as exc_info:
                create_evidence_bundle(client, "inc_001")
        assert exc_info.value.code == "bad_response"


class TestGetEvidenceBundle:
    def test_get_by_id(self):
        client = _client()
        with patch.object(
            client._client,
            "request",
            return_value=_mock_response(SAMPLE_BUNDLE),
        ) as mock_req:
            result = get_evidence_bundle(client, "bundle_abc123")
        assert result["bundle_id"] == "bundle_abc123"
        assert mock_req.call_args[0][0] == "GET"
        assert "bundle_abc123" in mock_req.call_args[0][1]

    def test_get_empty_id_raises(self):
        client = _client()
        with pytest.raises(AtlaSentError) as exc_info:
            get_evidence_bundle(client, "")
        assert exc_info.value.code == "bad_request"

    def test_get_url_encodes_id(self):
        client = _client()
        with patch.object(
            client._client,
            "request",
            return_value=_mock_response(SAMPLE_BUNDLE),
        ) as mock_req:
            get_evidence_bundle(client, "bundle/with/slashes")
        url = mock_req.call_args[0][1]
        assert "bundle%2Fwith%2Fslashes" in url

    def test_get_404_raises(self):
        client = _client()
        with patch.object(
            client._client,
            "request",
            return_value=_mock_response({"error": "not found"}, 404),
        ):
            with pytest.raises(AtlaSentError) as exc_info:
                get_evidence_bundle(client, "missing")
        assert exc_info.value.status_code == 404

    def test_get_json_error_no_message(self):
        client = _client()
        resp = MagicMock(spec=httpx.Response)
        resp.status_code = 400
        resp.headers = {"X-Request-ID": "req-123"}
        resp.json = MagicMock(side_effect=ValueError("no json"))
        with patch.object(client._client, "request", return_value=resp):
            with pytest.raises(AtlaSentError) as exc_info:
                get_evidence_bundle(client, "bundle_abc")
        assert exc_info.value.status_code == 400

    def test_get_204_returns_none(self):
        client = _client()
        resp = MagicMock(spec=httpx.Response)
        resp.status_code = 204
        resp.headers = {"X-Request-ID": "req-123"}
        with patch.object(client._client, "request", return_value=resp):
            result = get_evidence_bundle(client, "bundle_abc")
        assert result is None


class TestDownloadEvidenceBundle:
    def test_download_json_default(self):
        client = _client()
        pdf_bytes = b'{"bundle": "data"}'
        resp = MagicMock(spec=httpx.Response)
        resp.status_code = 200
        resp.headers = {"X-Request-ID": "req-123"}
        resp.content = pdf_bytes
        with patch.object(client._client, "request", return_value=resp) as mock_req:
            result = download_evidence_bundle(client, "bundle_abc")
        assert result == pdf_bytes
        url = mock_req.call_args[0][1]
        assert "format=json" in url

    def test_download_pdf_format(self):
        client = _client()
        pdf_bytes = b"%PDF-1.4 ..."
        resp = MagicMock(spec=httpx.Response)
        resp.status_code = 200
        resp.headers = {"X-Request-ID": "req-123"}
        resp.content = pdf_bytes
        with patch.object(client._client, "request", return_value=resp) as mock_req:
            result = download_evidence_bundle(client, "bundle_abc", format="pdf")
        assert result == pdf_bytes
        url = mock_req.call_args[0][1]
        assert "format=pdf" in url

    def test_download_empty_id_raises(self):
        client = _client()
        with pytest.raises(AtlaSentError) as exc_info:
            download_evidence_bundle(client, "")
        assert exc_info.value.code == "bad_request"

    def test_download_url_encodes_id(self):
        client = _client()
        resp = MagicMock(spec=httpx.Response)
        resp.status_code = 200
        resp.headers = {"X-Request-ID": "req-123"}
        resp.content = b"data"
        with patch.object(client._client, "request", return_value=resp) as mock_req:
            download_evidence_bundle(client, "bundle/abc")
        url = mock_req.call_args[0][1]
        assert "bundle%2Fabc" in url

    def test_download_404_raises(self):
        client = _client()
        with patch.object(
            client._client,
            "request",
            return_value=_mock_response({"error": "not found"}, 404),
        ):
            with pytest.raises(AtlaSentError) as exc_info:
                download_evidence_bundle(client, "bundle_abc")
        assert exc_info.value.status_code == 404

    def test_download_malformed_json_on_error_still_raises(self):
        client = _client()
        resp = MagicMock(spec=httpx.Response)
        resp.status_code = 500
        resp.headers = {"X-Request-ID": "req-123"}
        resp.json = MagicMock(side_effect=ValueError("no json"))
        with patch.object(client._client, "request", return_value=resp):
            with pytest.raises(AtlaSentError) as exc_info:
                download_evidence_bundle(client, "bundle_abc")
        assert exc_info.value.status_code == 500
