"""Response-shape adapter.

The AtlaSent API is rolling out SDK-shaped response aliases
(`permitted`, `decision_id`, `reason`, `audit_hash`, `timestamp`,
`verified`, `permit_hash`) as an additive change — servers in the
wild may still return only the native fields (`decision: "allow"`,
`permit_token: "..."`, `audit_entry_hash: "..."`, `valid: true`).

This module normalizes both shapes into the SDK-canonical form *before*
Pydantic validation, so the Python SDK works against:

- legacy servers that only send native fields;
- realigned servers that send both shapes;
- future servers that may drop the natives.

The adapter is strictly non-destructive: if a canonical key is already
present it wins, the native-derived value is only used as a fallback.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


def _iso_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def normalize_evaluate_response(data: Any) -> dict[str, Any]:
    """Return ``data`` with SDK-canonical evaluate keys populated.

    Handles the three shapes:

    - canonical: ``{permitted, decision_id, reason, audit_hash, timestamp}``
    - native:    ``{decision: "allow"|"deny"|..., permit_token, audit_entry_hash, request_id}``
    - mixed:     both sets present (current server during rollout)

    Non-dict input is returned unchanged so the caller's validation
    path reports a clean "bad_response" error.
    """
    if not isinstance(data, dict):
        return data  # type: ignore[return-value]

    out = dict(data)

    if "permitted" not in out:
        decision = out.get("decision")
        if isinstance(decision, str):
            out["permitted"] = decision == "allow"
        elif isinstance(decision, bool):
            out["permitted"] = decision

    if "decision_id" not in out:
        token = out.get("permit_token")
        if isinstance(token, str) and token:
            out["decision_id"] = token
        else:
            req_id = out.get("request_id")
            if isinstance(req_id, str) and req_id:
                out["decision_id"] = req_id

    if "audit_hash" not in out:
        entry_hash = out.get("audit_entry_hash")
        if isinstance(entry_hash, str):
            out["audit_hash"] = entry_hash

    if "reason" not in out:
        deny_reason = out.get("deny_reason")
        if isinstance(deny_reason, str):
            out["reason"] = deny_reason

    if "timestamp" not in out or not isinstance(out.get("timestamp"), str):
        out["timestamp"] = _iso_now()

    return out


def normalize_verify_response(data: Any) -> dict[str, Any]:
    """Return ``data`` with SDK-canonical verify keys populated.

    Handles both shapes:

    - canonical: ``{verified, outcome, permit_hash, timestamp}``
    - native:    ``{valid, outcome, decision, reason}``

    Non-dict input is returned unchanged.
    """
    if not isinstance(data, dict):
        return data  # type: ignore[return-value]

    out = dict(data)

    if "verified" not in out:
        valid = out.get("valid")
        if isinstance(valid, bool):
            out["verified"] = valid

    if "permit_hash" not in out:
        out["permit_hash"] = ""

    if "timestamp" not in out or not isinstance(out.get("timestamp"), str):
        out["timestamp"] = _iso_now()

    return out
