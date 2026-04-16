"""Batch evaluation — check multiple actions at once.

Useful when an agent's workflow involves several steps that all
need authorization before the workflow begins.
"""

import atlasent

atlasent.configure(api_key="ask_live_your_key_here")

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

results = []
all_permitted = True

for step in actions:
    result = atlasent.authorize(
        agent=AGENT_ID,
        action=step["action"],
        context=step["context"],
    )
    results.append(result)

    status = "PERMITTED" if result else "DENIED"
    print(f"  [{status}] {step['action']}")
    print(f"           reason: {result.reason}")
    print(f"           decision_id: {result.decision_id}\n")

    if not result:
        all_permitted = False

if all_permitted:
    print("All actions permitted — pipeline may proceed.")
    print("Decision IDs for audit log:")
    for r in results:
        print(f"  {r.decision_id}  (hash: {r.audit_hash})")
else:
    print("One or more actions denied — pipeline halted.")
