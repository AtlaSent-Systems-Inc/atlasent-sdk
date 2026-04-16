"""Clinical Data Agent — GxP authorization example.

Demonstrates an AI agent that:
1. Attempts to modify a patient record WITHOUT required context → denied
2. Retries WITH full context → permitted + verified
3. Prints the audit hash for 21 CFR Part 11 records
"""

from atlasent import AtlaSentClient, AtlaSentDenied

client = AtlaSentClient(api_key="ask_live_your_key_here")

AGENT_ID = "clinical-data-agent-v2"

# ── Attempt 1: missing context ────────────────────────────────────────

print("── Attempt 1: update patient record (no context) ──")

try:
    client.evaluate(
        action_type="update_patient_record",
        actor_id=AGENT_ID,
    )
    print("Permitted — proceeding with update")
except AtlaSentDenied as e:
    print(f"Denied — {e.reason}")
    print(f"Decision ID: {e.permit_token}")

# ── Attempt 2: full context provided ─────────────────────────────────

print("\n── Attempt 2: update patient record (full context) ──")

try:
    result = client.gate(
        action_type="update_patient_record",
        actor_id=AGENT_ID,
        context={
            "patient_id": "PT-2024-001",
            "study_id": "TRIAL-GXP-042",
            "site_id": "SITE-US-003",
            "change_reason": "Correcting lab value transcription error",
            "operator": "Dr. Jane Smith",
            "gxp_classification": "critical",
        },
    )
    print(f"Permitted — token: {result.evaluation.permit_token}")
    print(f"  reason: {result.evaluation.reason}")
    if result.verification.valid:
        print(f"  permit_hash:  {result.verification.permit_hash}")
        print(f"  audit_hash:   {result.evaluation.audit_hash}")
        print("  Ready for 21 CFR Part 11 audit trail")
    else:
        print("  Permit verification failed — do not proceed")
except AtlaSentDenied as e:
    print(f"Denied again — {e.reason}")
