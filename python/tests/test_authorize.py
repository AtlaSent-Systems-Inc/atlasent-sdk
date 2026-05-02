"""Tests for top-level convenience functions."""

import pytest

from atlasent import configure, evaluate, gate, verify
from atlasent.authorize import _reset_default_client
from atlasent.config import reset
from atlasent.exceptions import ConfigurationError

EVALUATE_PERMIT = {
    "permitted": True,
    "decision_id": "dec_200",
    "reason": "OK",
    "audit_hash": "hash_200",
    "timestamp": "2025-01-15T14:00:00Z",
}

VERIFY_OK = {
    "verified": True,
    "permit_hash": "permit_200",
    "timestamp": "2025-01-15T14:01:00Z",
}


@pytest.fixture(autouse=True)
def _clean():
    reset()
    _reset_default_client()
    yield
    reset()
    _reset_default_client()


class TestEvaluate:
    def test_with_global_config(self, mocker):
        configure(api_key="ask_test_global")
        mock_post = mocker.patch("atlasent.client.httpx.Client.post")
        mock_post.return_value.status_code = 200
        mock_post.return_value.json.return_value = EVALUATE_PERMIT

        result = evaluate("read_data", "agent-1")

        assert result.permit_token == "dec_200"

    def test_no_key_raises(self, mocker):
        mocker.patch.dict("os.environ", {}, clear=True)
        with pytest.raises(ConfigurationError, match="No API key"):
            evaluate("read_data", "agent-1")


class TestVerify:
    def test_with_global_config(self, mocker):
        configure(api_key="ask_test_xxxxxxxx")
        mock_post = mocker.patch("atlasent.client.httpx.Client.post")
        mock_post.return_value.status_code = 200
        mock_post.return_value.json.return_value = VERIFY_OK

        result = verify("dec_200")

        assert result.valid is True


class TestGate:
    def test_with_global_config(self, mocker):
        configure(api_key="ask_test_xxxxxxxx")
        mock_post = mocker.patch("atlasent.client.httpx.Client.post")
        mock_post.return_value.status_code = 200
        mock_post.return_value.json.side_effect = [EVALUATE_PERMIT, VERIFY_OK]

        result = gate("read_data", "agent-1")

        assert result.evaluation.permit_token == "dec_200"
        assert result.verification.valid is True


class TestSingleton:
    def test_reuses_client(self, mocker):
        configure(api_key="ask_test_xxxxxxxx")
        mock_post = mocker.patch("atlasent.client.httpx.Client.post")
        mock_post.return_value.status_code = 200
        mock_post.return_value.json.return_value = EVALUATE_PERMIT

        evaluate("a", "b")
        evaluate("a", "c")

        assert mock_post.call_count == 2
