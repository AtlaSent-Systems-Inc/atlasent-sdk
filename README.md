# AtlaSent Python SDK

Execution-time authorization for AI agents in GxP-regulated environments. Fail-closed by design — no action proceeds without an explicit permit.

```
pip install atlasent
```

## Quickstart

```python
from atlasent import AtlaSentClient, AtlaSentDenied

client = AtlaSentClient(api_key="ask_live_...")

try:
    result = client.gate(
        action_type="modify_patient_record",
        actor_id="clinical-data-agent",
        context={"patient_id": "PT-2024-001", "operator": "dr_smith"},
    )
    # Action permitted and verified
    print(result.evaluation.permit_token)
    print(result.verification.permit_hash)
except AtlaSentDenied as e:
    # Action explicitly denied
    print(f"Blocked: {e.reason}")
```

## What just happened

AtlaSent evaluated your agent action against your GxP policy, generated a hash-chained audit entry, and verified the permit — all before your agent touched any data. Every call is logged, timestamped, and exportable for FDA inspection.

## Three methods

### `evaluate()` — ask for permission

```python
result = client.evaluate("read_patient_record", "my-agent", {"patient_id": "PT-001"})
# → EvaluateResult(decision=True, permit_token="dec_...", reason="...", audit_hash="...")
```

Raises `AtlaSentDenied` if the action is denied. Returns `EvaluateResult` on permit.

### `verify()` — confirm a permit token

```python
verification = client.verify(result.permit_token, "read_patient_record", "my-agent")
# → VerifyResult(valid=True, permit_hash="...", timestamp="...")
```

### `gate()` — evaluate + verify in one call

```python
gate_result = client.gate("read_patient_record", "my-agent", {"patient_id": "PT-001"})
# → GateResult(evaluation=EvaluateResult(...), verification=VerifyResult(...))
```

The happy-path shortcut. Calls `evaluate()`, then immediately `verify()` with the resulting permit token.

## Async support

```python
from atlasent import AsyncAtlaSentClient

async with AsyncAtlaSentClient(api_key="ask_live_...") as client:
    result = await client.gate("read_data", "my-agent")
```

Full parity with the sync client — same methods, same exceptions, same models.

## Fail-closed design

The SDK raises on any failure. No action can proceed without an explicit permit.

| Scenario | Exception |
|---|---|
| Action denied | `AtlaSentDenied` |
| Network error / timeout | `AtlaSentError` |
| Invalid API key | `AtlaSentError` (status 401) |
| Rate limited | `RateLimitError` (with `retry_after`) |
| Missing config | `ConfigurationError` |

```python
from atlasent import AtlaSentDenied, AtlaSentError, RateLimitError

try:
    result = client.gate("write_data", "agent-1")
except AtlaSentDenied as e:
    print(e.reason, e.permit_token, e.decision)
except RateLimitError as e:
    time.sleep(e.retry_after or 30)
except AtlaSentError as e:
    print(e.message, e.status_code)
```

## Configuration

```python
from atlasent import AtlaSentClient

# Explicit
client = AtlaSentClient(
    api_key="ask_live_...",
    anon_key="ask_anon_...",        # optional, for client-side contexts
    base_url="https://api.atlasent.io",  # default
    timeout=10,                      # seconds, default
    max_retries=2,                   # on 5xx/timeouts, default
    retry_backoff=0.5,               # seconds, doubles each retry
)

# Or use environment variables
# ATLASENT_API_KEY=ask_live_...
# ATLASENT_ANON_KEY=ask_anon_...
```

### Global config (convenience functions)

```python
import atlasent

atlasent.configure(api_key="ask_live_...")
result = atlasent.evaluate("read_data", "my-agent")
result = atlasent.gate("read_data", "my-agent")
```

## Framework integration

### FastAPI

```python
from fastapi import FastAPI, HTTPException
from atlasent import AsyncAtlaSentClient, AtlaSentDenied

app = FastAPI()
client = AsyncAtlaSentClient(api_key="ask_live_...")

@app.post("/modify-record")
async def modify_record(patient_id: str, agent_id: str):
    try:
        gate = await client.gate(
            "modify_patient_record", agent_id,
            {"patient_id": patient_id},
        )
    except AtlaSentDenied as e:
        raise HTTPException(403, detail=e.reason)

    # Proceed — action is permitted and verified
    return {"permit_hash": gate.verification.permit_hash}
```

### Flask

```python
from flask import Flask, jsonify, abort
from atlasent import AtlaSentClient, AtlaSentDenied

app = Flask(__name__)
client = AtlaSentClient(api_key="ask_live_...")

@app.route("/modify-record", methods=["POST"])
def modify_record():
    try:
        gate = client.gate(
            "modify_patient_record", "flask-agent",
            {"patient_id": request.json["patient_id"]},
        )
    except AtlaSentDenied as e:
        abort(403, description=e.reason)

    return jsonify(permit_hash=gate.verification.permit_hash)
```

## Response models

All responses are Pydantic v2 models.

**`EvaluateResult`** — returned by `evaluate()` on permit:
- `decision: bool` — `True` when permitted
- `permit_token: str` — opaque token for verification
- `reason: str` — human-readable explanation
- `audit_hash: str` — hash-chained audit trail entry
- `timestamp: str` — ISO 8601

**`VerifyResult`** — returned by `verify()`:
- `valid: bool` — whether the permit is still valid
- `permit_hash: str` — the permit hash
- `timestamp: str` — ISO 8601

**`GateResult`** — returned by `gate()`:
- `evaluation: EvaluateResult`
- `verification: VerifyResult`

## Get your API key

Sign up at [atlasent.io](https://atlasent.io) → Settings → API Keys

## Docs

Full documentation at [docs.atlasent.io](https://docs.atlasent.io)

## License

MIT
