"""Clinical Data Agent — GxP authorization example.

Demonstrates `atlasent.protect()` — the one-call, fail-closed
category primitive — for an AI agent that modifies clinical-trial
patient records under 21 CFR Part 11 / GxP.

Three scenarios:
    1. Missing context  →  AtlaSentDeniedError (policy denial)
    2. Full context     →  Permit returned (permitted + verified)
    3. Prohibited action →  AtlaSentDeniedError (policy engine never allows)

Run::

    export ATLASENT_API_KEY=ask_live_...
    python examples/clinical_data_agent.py
"""

from __future__ import annotations

import os

from atlasent import AtlaSentDeniedError, configure, protect

configure(api_key=os.environ.get("ATLASENT_API_KEY", "ask_live_your_key_here"))

AGENT = "clinical-data-agent"
ACTION = "modify_patient_record"


def banner(title: str) -> None:
    print(f"\n── {title} " + "─" * (60 - len(title)))


# ── Scenario 1: missing context → AtlaSentDeniedError ────────────────

banner("Scenario 1: missing context")

try:
    permit = protect(
        agent=AGENT,
        action=ACTION,
        context={"user": "dr_smith"},  # missing change_reason, study_id
    )
    print("Permitted — proceeding (unexpected)")
except AtlaSentDeniedError as exc:
    print(f"Denied: {exc.reason}")
    print(f"  decision:      {exc.decision}")
    print(f"  evaluation_id: {exc.evaluation_id}")


# ── Scenario 2: full GxP context → verified Permit ───────────────────

banner("Scenario 2: full GxP context")

try:
    permit = protect(
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
    # ── execute the action — authorization is on file ────────────────
    print(f"Permitted: {permit.reason}")
    print(f"  permit_id:   {permit.permit_id}")
    print(f"  permit_hash: {permit.permit_hash}")
    print(f"  audit_hash:  {permit.audit_hash}")
    print(f"  timestamp:   {permit.timestamp}")
    print("  → 21 CFR Part 11 audit trail recorded")
except AtlaSentDeniedError as exc:
    print(f"Denied: {exc.reason}")


# ── Scenario 3: prohibited action — always denied ────────────────────

banner("Scenario 3: prohibited action (delete_audit_log)")

try:
    protect(
        agent=AGENT,
        action="delete_audit_log",  # never permitted under GxP
        context={"user": "dr_smith", "environment": "production"},
    )
    print("Permitted (unexpected)")
except AtlaSentDeniedError as exc:
    print(f"Blocked at the SDK boundary: {exc.reason}")
    print(f"  decision:      {exc.decision}")
    print(f"  evaluation_id: {exc.evaluation_id}")
