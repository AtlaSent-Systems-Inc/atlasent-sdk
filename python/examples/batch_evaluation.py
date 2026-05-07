"""Batch evaluation — check multiple actions before proceeding.

Useful when an agent's workflow involves several steps that all
need authorization before the workflow begins. Each step is gated
with :meth:`AtlaSentClient.protect` (fail-closed): on allow it
returns a verified :class:`~atlasent.Permit`; on deny it raises
:class:`~atlasent.AtlaSentDeniedError`.
"""

from atlasent import AtlaSentClient, AtlaSentDeniedError

client = AtlaSentClient(api_key="ask_live_your_key_here")

AGENT_ID = "etl-pipeline-agent"

actions = [
    {
        "action": "read_source_database",
        "context": {"database": "clinical_trials_prod", "table": "lab_results"},
    },
    {
        "action": "transform_patient_data",
        "context": {"operation": "anonymize", "fields": ["name", "dob", "ssn"]},
    },
    {
        "action": "write_data_warehouse",
        "context": {"destination": "analytics_dw", "schema": "transformed"},
    },
]

print(f"Evaluating {len(actions)} actions for agent '{AGENT_ID}'...\n")

permits = []
all_permitted = True

for step in actions:
    try:
        permit = client.protect(
            agent=AGENT_ID,
            action=step["action"],
            context=step["context"],
        )
        permits.append(permit)
        print(f"  [PERMITTED] {step['action']}")
        print(f"              permit_id: {permit.permit_id}\n")
    except AtlaSentDeniedError as exc:
        all_permitted = False
        print(f"  [DENIED]    {step['action']}")
        print(f"              reason: {exc.reason}\n")

if all_permitted:
    print("All actions permitted — pipeline may proceed.")
    print("Audit trail:")
    for p in permits:
        print(f"  {p.permit_id}  (audit_hash: {p.audit_hash})")
else:
    print("One or more actions denied — pipeline halted.")
