"""Coverage tests for with_permit hash canonicalization helper."""

from __future__ import annotations

from atlasent.with_permit import _compute_execution_hash


def test_compute_execution_hash_is_deterministic_for_reordered_payloads() -> None:
    payload_a = {
        "action_type": "production.deploy",
        "actor_id": "agent_1",
        "context": {"z": 2, "a": 1, "nested": [{"k2": "v2", "k1": "v1"}]},
    }
    payload_b = {
        "actor_id": "agent_1",
        "context": {"a": 1, "nested": [{"k1": "v1", "k2": "v2"}], "z": 2},
        "action_type": "production.deploy",
    }
    assert _compute_execution_hash(payload_a) == _compute_execution_hash(payload_b)


def test_compute_execution_hash_changes_when_payload_changes() -> None:
    base = {
        "action_type": "production.deploy",
        "actor_id": "agent_1",
        "context": {"environment": "production"},
    }
    changed = {
        "action_type": "production.deploy",
        "actor_id": "agent_1",
        "context": {"environment": "staging"},
    }
    assert _compute_execution_hash(base) != _compute_execution_hash(changed)
