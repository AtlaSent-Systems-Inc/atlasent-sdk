# AtlaSent Python SDK

Execution-time authorization for AI agents. One function call, one decision — fail-closed by design.

```bash
pip install atlasent
```

## Quickstart

```python
from atlasent import authorize

result = authorize(
    agent="clinical-data-agent",
    action="modify_patient_record",
    context={"user": "dr_smith", "environment": "production"},
)

if result.permitted:
    # execute action
    update_patient_record(...)
else:
    log.warning("Blocked: %s", result.reason)
```

That's it. `authorize()` calls the AtlaSent policy engine, generates a hash-chained audit entry (21 CFR Part 11 / GxP-ready), and returns a result you can branch on. No SDK setup, no client lifecycle, no boilerplate.

## Configure once

The SDK reads `ATLASENT_API_KEY` from the environment by default:

```bash
export ATLASENT_API_KEY=ask_live_...
```

Or configure it explicitly:

```python
import atlasent

atlasent.configure(api_key="ask_live_...")
```

## What `result` gives you

`authorize()` returns an `AuthorizationResult`:

| Field          | Type   | Description                                                  |
|----------------|--------|--------------------------------------------------------------|
| `permitted`    | `bool` | `True` if the action is authorized.                          |
| `reason`       | `str`  | Human-readable explanation from the policy engine.           |
| `permit_token` | `str`  | Opaque decision ID for audit lookup.                         |
| `audit_hash`   | `str`  | Hash-chained audit-trail entry.                              |
| `permit_hash`  | `str`  | Verification hash bound to the permit.                       |
| `verified`     | `bool` | `True` if the permit was server-verified end-to-end.         |
| `timestamp`    | `str`  | ISO 8601 timestamp of the decision.                          |
| `agent`        | `str`  | Echo of the `agent` you passed.                              |
| `action`       | `str`  | Echo of the `action` you passed.                             |
| `context`      | `dict` | Echo of the `context` you passed.                            |
| `raw`          | `dict` | The raw JSON response body.                                  |

`AuthorizationResult` is also truthy when permitted, so this works:

```python
if authorize(agent="a", action="b"):
    do_the_thing()
```

## Fail-closed by design

`authorize()` returns `permitted=False` on a clean policy denial. **Any other failure raises** — there is no silent permit:

| Scenario                  | Behavior                                       |
|---------------------------|------------------------------------------------|
| Action denied             | `result.permitted == False`                    |
| Network error / timeout   | raises `AtlaSentError`                         |
| Invalid API key (401)     | raises `AtlaSentError(status_code=401)`        |
| Rate limited (429)        | raises `RateLimitError(retry_after=...)`       |
| Missing config            | raises `ConfigurationError`                    |

For call sites that prefer exceptions on deny:

```python
from atlasent import authorize, PermissionDeniedError

try:
    authorize(
        agent="clinical-data-agent",
        action="delete_audit_log",
        context={"user": "dr_smith"},
        raise_on_deny=True,
    )
except PermissionDeniedError as exc:
    log.error("Blocked: %s", exc.reason)
```

## Async

```python
from atlasent import AsyncAtlaSentClient

async with AsyncAtlaSentClient(api_key="ask_live_...") as client:
    result = await client.authorize(
        agent="clinical-data-agent",
        action="modify_patient_record",
        context={"user": "dr_smith", "environment": "production"},
    )
    if result.permitted:
        ...
```

Full parity with the sync surface — same fields, same exceptions.

## Skip verification when you don't need it

By default `authorize()` calls both `POST /v1-evaluate` and `POST /v1-verify-permit`, returning a fully-verified result. To skip the verification round-trip (one fewer HTTP call):

```python
result = authorize(
    agent="agent-1",
    action="read_data",
    verify=False,
)
# result.permit_hash and result.verified will be empty / False
```

## Configuration

```python
from atlasent import AtlaSentClient

client = AtlaSentClient(
    api_key="ask_live_...",
    base_url="https://api.atlasent.io",  # default
    timeout=10,                          # seconds, default
    max_retries=2,                       # on 5xx / timeouts, default
    retry_backoff=0.5,                   # seconds, doubles each retry
)

result = client.authorize(
    agent="clinical-data-agent",
    action="modify_patient_record",
    context={"user": "dr_smith"},
)
```

Environment variables: `ATLASENT_API_KEY`, `ATLASENT_ANON_KEY`.

## Framework integration

### FastAPI

```python
from fastapi import FastAPI, HTTPException
from atlasent import AsyncAtlaSentClient

app = FastAPI()
client = AsyncAtlaSentClient(api_key="ask_live_...")

@app.post("/modify-record")
async def modify_record(patient_id: str, agent_id: str):
    result = await client.authorize(
        agent=agent_id,
        action="modify_patient_record",
        context={"patient_id": patient_id},
    )
    if not result.permitted:
        raise HTTPException(403, detail=result.reason)
    return {"permit_hash": result.permit_hash}
```

### Flask

```python
from flask import Flask, jsonify, abort, request
from atlasent import AtlaSentClient

app = Flask(__name__)
client = AtlaSentClient(api_key="ask_live_...")

@app.post("/modify-record")
def modify_record():
    result = client.authorize(
        agent="flask-agent",
        action="modify_patient_record",
        context={"patient_id": request.json["patient_id"]},
    )
    if not result.permitted:
        abort(403, description=result.reason)
    return jsonify(permit_hash=result.permit_hash)
```

## Export a signed audit bundle

For 21 CFR Part 11 / GxP reviewers: pull a tamper-evident, Ed25519-signed export of the evaluation + admin chains. Requires an API key with the `audit` scope.

```python
import json
from atlasent import AtlaSentClient

with AtlaSentClient(api_key="ask_live_...") as client:
    bundle = client.export_audit(
        since="2026-01-01T00:00:00Z",
        limit=5000,
    )

with open("atlasent-audit-export.json", "w") as f:
    json.dump(bundle.model_dump(), f, indent=2)
```

The envelope includes hash-chained rows, chain heads, the Ed25519 public key, and a base64 signature over the canonical bytes. Hand it to your offline verifier — `bundle.model_dump()` round-trips losslessly.

See `examples/export_audit.py` for a runnable script.

## Lower-level methods

`authorize()` is the recommended surface, but the underlying primitives are exported too:

- `client.evaluate(action, agent, context)` — policy decision only; raises `AtlaSentDenied` on denial.
- `client.verify(permit_token, ...)` — verify a previously issued permit.
- `client.export_audit(since=..., until=..., limit=..., include_admin_log=...)` — signed audit export.
- `client.gate(action, agent, context)` — evaluate + verify; raises on denial; returns `GateResult` with both response objects.
- `@atlasent_guard(...)` / `@async_atlasent_guard(...)` — decorators for Flask / FastAPI routes.
- `TTLCache` — opt-in in-process cache for hot-path evaluations.

See the docstrings and `examples/` for details.

## API endpoints

The SDK calls:

- `POST https://api.atlasent.io/v1-evaluate`
- `POST https://api.atlasent.io/v1-verify-permit`
- `POST https://api.atlasent.io/v1-export-audit`

Override the base URL with the `base_url` argument or `AtlaSentClient`.

## Get an API key

Sign up at [atlasent.io](https://atlasent.io) → Settings → API Keys.

## License

MIT — see [LICENSE](LICENSE).
