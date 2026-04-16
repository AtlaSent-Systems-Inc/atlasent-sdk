"""Batch evaluation — check multiple actions before proceeding.

Useful when an agent's workflow involves several steps that all
need authorization before the workflow begins.
"""

from atlasent import AtlaSentClient, AtlaSentDenied

client = AtlaSentClient(api_key="ask_live_your_key_here")

AGENT_ID = "etl-pipeline-agent"

actions = [
    {
        "action_type": "read_source_database",
        "context": {"database": "clinical_trials_prod", "table": "lab_results"},
    },
    {
        "action_type": "transform_patient_data",
        "context": {"operation": "anonymize", "fields": ["name", "dob", "ssn"]},
    },
    {
        "action_type": "write_data_warehouse",
        "context": {"destination": "analytics_dw", "schema": "transformed"},
    },
]

print(f"Evaluating {len(actions)} actions for agent '{AGENT_ID}'...\n")

results = []
all_permitted = True

for step in actions:
    try:
        result = client.gate(
            action_type=step["action_type"],
            actor_id=AGENT_ID,
            context=step["context"],
        )
        results.append(result)
        print(f"  [PERMITTED] {step['action_type']}")
        print(f"              token: {result.evaluation.permit_token}\n")
    except AtlaSentDenied as e:
        all_permitted = False
        print(f"  [DENIED]    {step['action_type']}")
        print(f"              reason: {e.reason}\n")

if all_permitted:
    print("All actions permitted — pipeline may proceed.")
    print("Audit tokens:")
    for r in results:
        print(f"  {r.evaluation.permit_token}  (hash: {r.evaluation.audit_hash})")
else:
    print("One or more actions denied — pipeline halted.")
