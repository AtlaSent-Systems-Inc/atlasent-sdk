"""Clinical Data Agent — GxP authorization example.

Demonstrates an AI agent that:
1. Attempts to modify a patient record WITHOUT required context → denied
2. Retries WITH full context → permitted
3. Verifies the permit and prints the audit hash for 21 CFR Part 11 records
"""

import atlasent

# Initialize with an explicit key (or rely on ATLASENT_API_KEY env var)
client = atlasent.AtlaSentClient(api_key="ask_live_your_key_here")

AGENT_ID = "clinical-data-agent-v2"

# ── Attempt 1: missing context ────────────────────────────────────────────

print("── Attempt 1: update patient record (no context) ──")

result = client.evaluate(
    agent=AGENT_ID,
    action="update_patient_record",
)

if result:
    print("Permitted — proceeding with update")
else:
    print(f"Denied — {result.reason}")
    print(f"Decision ID: {result.decision_id}")

# ── Attempt 2: full context provided ─────────────────────────────────────

print("\n── Attempt 2: update patient record (full context) ──")

result = client.evaluate(
    agent=AGENT_ID,
    action="update_patient_record",
    context={
        "patient_id": "PT-2024-001",
        "study_id": "TRIAL-GXP-042",
        "site_id": "SITE-US-003",
        "change_reason": "Correcting lab value transcription error",
        "operator": "Dr. Jane Smith",
        "gxp_classification": "critical",
    },
)

if result:
    print(f"Permitted — decision {result.decision_id}")
    print(f"  reason: {result.reason}")

    # Verify the permit for audit records
    verification = client.verify_permit(result.decision_id)
    if verification["verified"]:
        print(f"  permit_hash: {verification['permit_hash']}")
        print(f"  audit_hash:  {result.audit_hash}")
        print("  ✓ Ready for 21 CFR Part 11 audit trail")
    else:
        print("  ✗ Permit verification failed — do not proceed")
else:
    print(f"Denied again — {result.reason}")
