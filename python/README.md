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
    update_patient_record(...)
else:
    log.warning("Blocked: %s", result.reason)
```

`authorize()` calls the AtlaSent policy engine, generates a hash-chained audit entry (21 CFR Part 11 / GxP-ready), and returns a result you can branch on. No SDK setup, no client lifecycle, no boilerplate.

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

`AuthorizationResult` is also truthy when permitted:

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

## Streaming evaluation

Stream partial reasoning and the final decision as they arrive from the policy engine:

```python
from atlasent import AsyncAtlaSentClient

async with AsyncAtlaSentClient(api_key="ask_live_...") as client:
    async for event in client.evaluate_stream("read_phi", "agent-1"):
        if event.type == "reasoning":
            print("Policy engine:", event.content)
        elif event.type == "policy_check":
            print(f"  {event.policy_id}: {event.outcome}")
        elif event.type == "decision":
            if event.permitted:
                print("Permitted — token:", event.permit_token)
            else:
                print("Denied:", event.reason)
```

Events arrive in order: zero or more `"reasoning"` events, zero or more `"policy_check"` events, then exactly one `"decision"` event. A `DENY` decision is yielded — not raised — so your code always sees the final event.

## Offline audit verification

Verify an Ed25519-signed audit export bundle without any network call:

```bash
pip install "atlasent[audit]"
```

```python
from atlasent import verify_bundle

result = verify_bundle("/path/to/export.bundle.json")
if result.valid:
    print(f"Bundle intact — {result.event_count} events verified")
else:
    raise RuntimeError(f"Audit bundle tampered: {result.error}")
```

The `[audit]` extra adds `cryptography>=41.0`. The core SDK has no additional dependencies.

## Lower-level methods

`authorize()` is the recommended surface, but the underlying primitives are exported too:

- `client.evaluate(action, agent, context)` — policy decision only; raises `AtlaSentDenied` on denial.
- `client.verify(permit_token, ...)` — verify a previously issued permit.
- `client.gate(action, agent, context)` — evaluate + verify in one call; raises on denial; returns `GateResult`.
- `async_client.evaluate_stream(action, agent, context)` — async generator over SSE evaluation events.
- `verify_bundle(path)` — offline Ed25519 bundle verifier (no API call required).
- `@atlasent_guard(...)` / `@async_atlasent_guard(...)` — decorators for Flask / FastAPI routes.
- `TTLCache` — opt-in in-process cache for hot-path evaluations.

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

## API endpoints (0.1.0 surface)

| Method                | Endpoint                    |
|-----------------------|-----------------------------|
| `evaluate` / `gate`   | `POST /v1-evaluate`         |
| `verify`              | `POST /v1-verify-permit`    |
| `evaluate_stream`     | `POST /v1-evaluate-stream`  |
| `verify_bundle`       | *(offline — no API call)*   |

Override the base URL with the `base_url` argument or `AtlaSentClient`.

## Not included in 0.1.0

The following endpoints are deferred to a later release. Calling them will raise `NotImplementedError` or result in an HTTP 404 from the server:

- `POST /v1-session` — session management
- `GET/POST /v1-audit/events` — audit event queries
- `GET /v1-audit/exports` — audit export downloads
- `POST /v1-audit/verify` — server-side bundle verification
- `POST /v1-approvals` — human-in-the-loop approvals
- `POST /v1-overrides` — policy overrides
- `POST /v1-permits/consume` — permit consumption
- `POST /v1-permits/revoke` — permit revocation

Also deferred: generated Pydantic models from the OpenAPI spec (models are currently hand-maintained).

## Requirements

- Python **3.10** or newer
- `httpx>=0.24.0`, `pydantic>=2.0.0`
- Offline audit verification requires `pip install "atlasent[audit]"` (`cryptography>=41.0`)

## Get an API key

Sign up at [atlasent.io](https://atlasent.io) → Settings → API Keys.

## License

MIT — see [LICENSE](LICENSE).
