"""Test utilities — use MockAtlaSentClient in unit tests without an API key."""
from __future__ import annotations
import logging
from typing import Any, Dict, List, Optional


class MockAtlaSentClient:
    """Drop-in mock for unit tests. No API key or network required."""

    def __init__(self, default_decision: str = "allow") -> None:
        self.calls: List[Dict[str, Any]] = []
        self.default_decision = default_decision
        self._overrides: Dict[str, str] = {}

    def set_decision(self, action: str, decision: str) -> None:
        self._overrides[action] = decision

    def authorize(
        self,
        action: str,
        context: Optional[Dict[str, Any]] = None,
        agent_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        decision = self._overrides.get(action, self.default_decision)
        self.calls.append({"action": action, "context": context, "agent_id": agent_id, "decision": decision})
        if decision == "deny":
            try:
                from atlasent.exceptions import DeniedError
                raise DeniedError(action, "MockAtlaSentClient denial")
            except ImportError:
                raise PermissionError(f"Action '{action}' denied by MockAtlaSentClient")
        return {"decision": decision, "permit_id": f"mock-permit-{action}"}

    def verify_permit(self, permit_id: str) -> Dict[str, Any]:
        return {"permit_id": permit_id, "valid": True, "verified_at": "2026-04-18T00:00:00Z"}

    def assert_called_with(self, action: str) -> None:
        assert any(c["action"] == action for c in self.calls), \
            f"authorize() was never called with action={action!r}. Calls: {self.calls}"

    def assert_call_count(self, n: int) -> None:
        assert len(self.calls) == n, f"Expected {n} authorize() calls, got {len(self.calls)}"

    def reset(self) -> None:
        self.calls.clear()
