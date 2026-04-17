"""Clinical Data Agent — GxP authorization example.

Demonstrates the one-call ``authorize()`` API for an AI agent that
modifies clinical-trial patient records under 21 CFR Part 11 / GxP.

Three scenarios:
    1. Missing context  →  result.permitted is False (denied)
    2. Full context     →  result.permitted is True  (permitted + verified)
    3. raise_on_deny    →  PermissionDeniedError raised on denial

Run::

    export ATLASENT_API_KEY=ask_live_...
    python examples/clinical_data_agent.py
"""

from __future__ import annotations

import os

from atlasent import (
    PermissionDeniedError,
    authorize,
    configure,
)

configure(api_key=os.environ.get("ATLASENT_API_KEY", "ask_live_your_key_here"))

AGENT = "clinical-data-agent"
ACTION = "modify_patient_record"


def banner(title: str) -> None:
    print(f"\n── {title} " + "─" * (60 - len(title)))


# ── Scenario 1: missing context → permitted is False ─────────────────

banner("Scenario 1: missing context")

result = authorize(
    agent=AGENT,
    action=ACTION,
    context={"user": "dr_smith"},  # missing change_reason, study_id
)

if result.permitted:
    print("Permitted — proceeding (unexpected)")
else:
    print(f"Denied: {result.reason}")
    print(f"  decision_id: {result.permit_token}")


# ── Scenario 2: full GxP context → permitted + verified ──────────────

banner("Scenario 2: full GxP context")

result = authorize(
    agent=AGENT,
    action=ACTION,
    context={
        "user": "dr_smith",
        "environment": "production",
        "patient_id": "PT-2024-001",
        "study_id": "TRIAL-GXP-042",
        "site_id": "SITE-US-003",
        "change_reason": "Correcting lab value transcription error",
        "gxp_classification": "critical",
    },
)

if result.permitted:
    # ── execute the action — authorization is on file ────────────────
    print(f"Permitted: {result.reason}")
    print(f"  permit_token: {result.permit_token}")
    print(f"  permit_hash:  {result.permit_hash}")
    print(f"  audit_hash:   {result.audit_hash}")
    print(f"  verified:     {result.verified}")
    print(f"  timestamp:    {result.timestamp}")
    print("  → 21 CFR Part 11 audit trail recorded")
else:
    print(f"Denied: {result.reason}")


# ── Scenario 3: raise_on_deny for fail-closed call sites ─────────────

banner("Scenario 3: raise_on_deny")

try:
    authorize(
        agent=AGENT,
        action="delete_audit_log",  # never permitted under GxP
        context={"user": "dr_smith", "environment": "production"},
        raise_on_deny=True,
    )
    print("Permitted (unexpected)")
except PermissionDeniedError as exc:
    print(f"Blocked at the SDK boundary: {exc.reason}")
    print(f"  decision: {exc.decision}")
    print(f"  token:    {exc.permit_token}")
