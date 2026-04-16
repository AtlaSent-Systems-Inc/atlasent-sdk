"""AtlaSent SDK data models."""

from dataclasses import dataclass


@dataclass
class AuthorizationResult:
    """Result of an authorization evaluation.

    Supports boolean conversion so you can write:

        result = authorize(agent, action)
        if result:
            # action is permitted
    """

    permitted: bool
    decision_id: str
    reason: str
    audit_hash: str
    timestamp: str

    def __bool__(self) -> bool:
        return self.permitted
