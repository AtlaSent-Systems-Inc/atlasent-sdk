"""Tests for atlasent.testing.MockAtlaSentClient."""
import pytest
from atlasent.testing import MockAtlaSentClient


def test_default_allow():
    client = MockAtlaSentClient()
    result = client.authorize("read_data")
    assert result["decision"] == "allow"
    assert "permit_id" in result


def test_default_deny():
    client = MockAtlaSentClient(default_decision="deny")
    with pytest.raises(Exception):
        client.authorize("delete_record")


def test_per_action_override():
    client = MockAtlaSentClient(default_decision="allow")
    client.set_decision("dangerous_action", "deny")
    assert client.authorize("safe_action")["decision"] == "allow"
    with pytest.raises(Exception):
        client.authorize("dangerous_action")


def test_assert_called_with():
    client = MockAtlaSentClient()
    client.authorize("deploy")
    client.assert_called_with("deploy")
    with pytest.raises(AssertionError):
        client.assert_called_with("never_called")


def test_reset():
    client = MockAtlaSentClient()
    client.authorize("action1")
    client.reset()
    assert client.calls == []
