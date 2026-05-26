"""Tests for atlasent.evidence_exports — evidence bundle export helpers."""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import httpx
import pytest

from atlasent import AtlaSentClient
from atlasent.evidence_exports import (
    create_evidence_export,
    get_evidence_export,
    list_evidence_exports,
)
from atlasent.exceptions import AtlaSentError

API_KEY = "ask_test_evidence_exports"
BASE_URL = "https://api.atlasent.io"
ORG_ID = "org_test_abc"
EXPORT_ID = "export-uuid-1234"

EXPORT_RECORD = {
    "id": EXPORT_ID,
    "org_id": ORG_ID,
    "regime": "soc2_type_ii",
    "window_from": "2026-02-01T00:00:00.000Z",
    "window_to": "2026-05-01T00:00:00.000Z",
    "bundle": {"bundle_id": "bundle-uuid-abc", "summary": {}},
    "bundle_sha256": "deadbeef" * 8,
    "controls_total": 10,
    "controls_evidenced": 7,
    "controls_partial": 2,
    "controls_missing": 1,
    "generated_by": "alice@example.com",
    "generated_at": "2026-05-23T00:00:00.000Z",
}

CREATE_RESPONSE = {
    "export": EXPORT_RECORD,
    "bundle": EXPORT_RECORD["bundle"],
    "sha256": EXPORT_RECORD["bundle_sha256"],
}


def _client() -> AtlaSentClient:
    return AtlaSentClient(api_key=API_KEY, base_url=BASE_URL)


def _mock_response(body: object, status: int = 200) -> MagicMock:
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status
    resp.headers = {}
    resp.json = MagicMock(return_value=body)
    resp.text = json.dumps(body) if body is not None else ""
    return resp


class TestListEvidenceExports:
    def test_list_returns_exports(self):
        client = _client()
        payload = {"exports": [EXPORT_RECORD]}
        with patch.object(
            client._client, "request", return_value=_mock_response(payload)
        ) as mock_req:
            result = list_evidence_exports(client, ORG_ID)
        assert result["exports"][0]["id"] == EXPORT_ID
        assert mock_req.call_args[0][0] == "GET"
        assert f"/v1/orgs/{ORG_ID}/evidence-exports" in mock_req.call_args[0][1]

    def test_list_without_regime_no_query_param(self):
        client = _client()
        payload = {"exports": []}
        with patch.object(
            client._client, "request", return_value=_mock_response(payload)
        ) as mock_req:
            list_evidence_exports(client, ORG_ID)
        url = mock_req.call_args[0][1]
        assert "regime" not in url

    def test_list_with_regime_passes_query_param(self):
        client = _client()
        payload = {"exports": [EXPORT_RECORD]}
        with patch.object(
            client._client, "request", return_value=_mock_response(payload)
        ) as mock_req:
            result = list_evidence_exports(client, ORG_ID, regime="soc2_type_ii")
        assert result["exports"][0]["regime"] == "soc2_type_ii"
        url = mock_req.call_args[0][1]
        assert "regime=soc2_type_ii" in url

    def test_list_with_hipaa_regime(self):
        client = _client()
        payload = {"exports": []}
        with patch.object(
            client._client, "request", return_value=_mock_response(payload)
        ) as mock_req:
            list_evidence_exports(client, ORG_ID, regime="hipaa")
        url = mock_req.call_args[0][1]
        assert "regime=hipaa" in url

    def test_list_invalid_regime_raises_value_error(self):
        client = _client()
        with pytest.raises(ValueError, match="regime"):
            list_evidence_exports(client, ORG_ID, regime="pci_dss")  # type: ignore[arg-type]

    def test_list_500_raises_server_error(self):
        client = _client()
        with patch.object(
            client._client,
            "request",
            return_value=_mock_response({"error": "internal"}, 500),
        ):
            with pytest.raises(AtlaSentError) as exc_info:
                list_evidence_exports(client, ORG_ID)
        assert exc_info.value.status_code == 500


class TestGetEvidenceExport:
    def test_get_returns_record(self):
        client = _client()
        with patch.object(
            client._client, "request", return_value=_mock_response(EXPORT_RECORD)
        ) as mock_req:
            result = get_evidence_export(client, ORG_ID, EXPORT_ID)
        assert result["id"] == EXPORT_ID
        assert result["regime"] == "soc2_type_ii"
        assert mock_req.call_args[0][0] == "GET"
        assert (
            f"/v1/orgs/{ORG_ID}/evidence-exports/{EXPORT_ID}"
            in mock_req.call_args[0][1]
        )

    def test_get_404_raises(self):
        client = _client()
        with patch.object(
            client._client,
            "request",
            return_value=_mock_response(
                {"error": f"Evidence export {EXPORT_ID} not found"}, 404
            ),
        ):
            with pytest.raises(AtlaSentError) as exc_info:
                get_evidence_export(client, ORG_ID, EXPORT_ID)
        assert exc_info.value.status_code == 404
        assert "not found" in str(exc_info.value).lower()

    def test_get_url_encodes_ids(self):
        client = _client()
        org = "org/with spaces"
        eid = "export/id&special"
        with patch.object(
            client._client, "request", return_value=_mock_response(EXPORT_RECORD)
        ) as mock_req:
            get_evidence_export(client, org, eid)
        url = mock_req.call_args[0][1]
        assert "org%2Fwith%20spaces" in url
        assert "export%2Fid%26special" in url


class TestCreateEvidenceExport:
    def test_create_happy_path(self):
        client = _client()
        with patch.object(
            client._client, "request", return_value=_mock_response(CREATE_RESPONSE, 201)
        ) as mock_req:
            result = create_evidence_export(client, ORG_ID, regime="soc2_type_ii")
        assert result["export"]["id"] == EXPORT_ID
        assert result["sha256"] == EXPORT_RECORD["bundle_sha256"]
        assert mock_req.call_args[0][0] == "POST"
        assert f"/v1/orgs/{ORG_ID}/evidence-exports" in mock_req.call_args[0][1]
        sent = json.loads(mock_req.call_args[1]["content"])
        assert sent["regime"] == "soc2_type_ii"

    def test_create_with_window(self):
        client = _client()
        window = {"from": "2026-02-01T00:00:00Z", "to": "2026-05-01T00:00:00Z"}
        with patch.object(
            client._client, "request", return_value=_mock_response(CREATE_RESPONSE, 201)
        ) as mock_req:
            create_evidence_export(client, ORG_ID, regime="hipaa", window=window)
        sent = json.loads(mock_req.call_args[1]["content"])
        assert sent["window"] == window
        assert sent["regime"] == "hipaa"

    def test_create_with_bundle_id(self):
        client = _client()
        with patch.object(
            client._client, "request", return_value=_mock_response(CREATE_RESPONSE, 201)
        ) as mock_req:
            create_evidence_export(
                client, ORG_ID, regime="gdpr", bundle_id="my-bundle-id"
            )
        sent = json.loads(mock_req.call_args[1]["content"])
        assert sent["bundle_id"] == "my-bundle-id"

    def test_create_with_evidence(self):
        client = _client()
        evidence = {"manual": {"incident_report": "IR-42"}}
        with patch.object(
            client._client, "request", return_value=_mock_response(CREATE_RESPONSE, 201)
        ) as mock_req:
            create_evidence_export(
                client, ORG_ID, regime="soc2_type_ii", evidence=evidence
            )
        sent = json.loads(mock_req.call_args[1]["content"])
        assert sent["manual"] == {"incident_report": "IR-42"}

    def test_create_omits_optional_fields_when_none(self):
        client = _client()
        with patch.object(
            client._client, "request", return_value=_mock_response(CREATE_RESPONSE, 201)
        ) as mock_req:
            create_evidence_export(client, ORG_ID, regime="gdpr")
        sent = json.loads(mock_req.call_args[1]["content"])
        assert "window" not in sent
        assert "bundle_id" not in sent

    def test_create_invalid_regime_raises_value_error(self):
        client = _client()
        with pytest.raises(ValueError, match="regime"):
            create_evidence_export(client, ORG_ID, regime="iso27001")  # type: ignore[arg-type]

    def test_create_all_valid_regimes(self):
        client = _client()
        for regime in ("soc2_type_ii", "hipaa", "gdpr"):
            with patch.object(
                client._client,
                "request",
                return_value=_mock_response(CREATE_RESPONSE, 201),
            ):
                result = create_evidence_export(client, ORG_ID, regime=regime)  # type: ignore[arg-type]
            assert result["export"]["id"] == EXPORT_ID

    def test_create_400_raises(self):
        client = _client()
        with patch.object(
            client._client,
            "request",
            return_value=_mock_response(
                {
                    "error": "window.from must be earlier than window.to",
                    "field": "window",
                },
                400,
            ),
        ):
            with pytest.raises(AtlaSentError) as exc_info:
                create_evidence_export(
                    client,
                    ORG_ID,
                    regime="soc2_type_ii",
                    window={
                        "from": "2026-05-01T00:00:00Z",
                        "to": "2026-02-01T00:00:00Z",
                    },
                )
        assert exc_info.value.status_code == 400
