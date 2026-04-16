# atlasent-sdk-python
AtlaSent Python SDK — authorize AI agent actions in GxP environments with one function call.

# AtlaSent Python SDK

Authorize your AI agents before they act. One function call. Full audit trail. FDA-ready.

## Install

pip install atlasent

## Quickstart

from atlasent import authorize

result = authorize(
    agent="clinical-data-agent",
    action="modify_patient_record",
    context={
        "user": "dr_smith",
        "environment": "production",
        "record_id": "PAT-001"
    }
)

if result.permitted:
    # safe to execute
    modify_patient_record()
else:
    raise PermissionError(f"Action blocked: {result.reason}")

## What just happened

AtlaSent evaluated your agent action against your GxP policy,
generated a hash-chained audit entry, and returned an authorization
decision — all before your agent touched any data.

Every call is logged, timestamped, and exportable for FDA inspection.

## Response object

result.permitted      # True / False
result.decision_id    # Unique ID for this authorization
result.reason         # Why it was permitted or blocked
result.audit_hash     # Hash-chained audit trail entry
result.timestamp      # ISO 8601

## Configuration

import atlasent

atlasent.configure(
    api_key="your_api_key",
    environment="production"  # or "sandbox"
)

## Get your API key

Sign up at atlasent.io → Settings → API Keys

## Docs

Full documentation at docs.atlasent.io

## License

MIT
