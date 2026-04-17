from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class Decision(str, Enum):
    allow = "allow"
    deny = "deny"
    hold = "hold"
    escalate = "escalate"


class AuthorizeResult(BaseModel):
    decision: Decision
    deny_code: str | None = None
    escalate_to: str | None = None
    permit_token: str | None = None
    meta: dict[str, Any] = Field(default_factory=dict)

    @property
    def permitted(self) -> bool:
        return self.decision == Decision.allow


class EvaluateRequest(BaseModel):
    agent_id: str = Field(alias="agentId")
    action_type: str = Field(alias="actionType")
    context: dict[str, Any] = Field(default_factory=dict)
    fail_mode: str = Field(default="closed", alias="failMode")

    model_config = {"populate_by_name": True}


class EvaluateResponse(BaseModel):
    decision: Decision
    deny_code: str | None = Field(default=None, alias="denyCode")
    escalate_to: str | None = Field(default=None, alias="escalateTo")
    permit_token: str | None = Field(default=None, alias="permitToken")
    meta: dict[str, Any] = Field(default_factory=dict)

    model_config = {"populate_by_name": True}


class VerifyPermitRequest(BaseModel):
    permit_token: str = Field(alias="permitToken")
    action_type: str = Field(alias="actionType")

    model_config = {"populate_by_name": True}


class VerifyPermitResponse(BaseModel):
    valid: bool
    reason: str | None = None
