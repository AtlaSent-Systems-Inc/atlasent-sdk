# AtlaSent Python SDK

**Execution-time authorization for AI agents.** One call before a sensitive
action runs. Fail-closed by design — no action proceeds without an explicit,
verified permit.

```bash
pip install atlasent
```

## Quickstart

```python
from atlasent import protect

permit = protect(
    agent="deploy-bot",
    action="deploy_to_production",
    context={"commit": commit, "approver": approver},
)
# If we got here, the action is authorized end-to-end.
# Otherwise protect() raised and the action never ran.
```

Set `ATLASENT_API_KEY` in the environment, or call
`atlasent.configure(api_key=...)`. That's the whole setup.

## The protect() contract

`atlasent.protect()` is the category primitive. On allow, it returns a
verified `Permit`. On anything else, it **raises**:

| Outcome                                   | Raises                                       |
|-------------------------------------------|----------------------------------------------|
| Policy `DENY`                             | `AtlaSentDeniedError`                        |
| Permit failed verification                | `AtlaSentDeniedError`                        |
| HTTP 401 / 403 / 4xx / 5xx                | `AtlaSentError` (with `.code`)               |
| Timeout / network failure                 | `AtlaSentError` (`code="timeout" / "network"`) |
| Rate limit (429)                          | `RateLimitError` (subclass of `AtlaSentError`, `.retry_after`) |

There is no `permitted=False` return path to forget. The action cannot
execute unless a `Permit` is in hand.

```python
from atlasent import protect, AtlaSentDeniedError, AtlaSentError

try:
    permit = protect(agent=agent, action=action, context=context)
    # Run the action. permit.permit_id + permit.audit_hash go in your log.
except AtlaSentDeniedError as exc:
    # Policy said no. exc.decision, exc.reason, exc.evaluation_id.
    log.warning("Denied: %s (evaluation_id=%s)", exc.reason, exc.evaluation_id)
except AtlaSentError as exc:
    # Transport / auth / server failure. exc.code, exc.status_code.
    log.error("AtlaSent unavailable: %s", exc)
```

`AtlaSentDeniedError` subclasses `AtlaSentDenied`, so
`except AtlaSentDenied:` still catches `protect()` denials. Use
`except AtlaSentDeniedError:` when you need to distinguish a policy
decision from a transport error.

## Async

```python
from atlasent import AsyncAtlaSentClient

async with AsyncAtlaSentClient(api_key="ask_live_...") as client:
    permit = await client.protect(
        agent="clinical-data-agent",
        action="modify_patient_record",
        context={"user": "dr_smith", "patient_id": "PT-001"},
    )
```

Full feature parity with the sync surface — same return type, same
exceptions, same fail-closed contract.

## What a Permit gives you

```python
@dataclass(frozen=True)
class Permit:
    permit_id: str     # opaque decision id (use for audit lookup)
    permit_hash: str   # verification hash bound to the permit
    audit_hash: str    # hash-chained audit-trail entry (21 CFR Part 11)
    reason: str        # policy engine's explanation
    timestamp: str     # ISO 8601 of the verification
```

Log `permit_id` + `audit_hash` for every action your code performs —
they're the two fields a regulator or support ticket will ask for.

## Framework integration

### FastAPI

```python
from fastapi import FastAPI, HTTPException
from atlasent import AsyncAtlaSentClient, AtlaSentDeniedError, AtlaSentError

app = FastAPI()
client = AsyncAtlaSentClient(api_key="ask_live_...")

@app.post("/modify-record")
async def modify_record(patient_id: str, agent_id: str):
    try:
        permit = await client.protect(
            agent=agent_id,
            action="modify_patient_record",
            context={"patient_id": patient_id},
        )
    except AtlaSentDeniedError as exc:
        raise HTTPException(403, detail=exc.reason) from None
    except AtlaSentError as exc:
        raise HTTPException(503, detail=str(exc)) from None
    return {"permit_id": permit.permit_id, "audit_hash": permit.audit_hash}
```

### Flask

```python
from flask import Flask, jsonify, abort, request
from atlasent import AtlaSentClient, AtlaSentDeniedError, AtlaSentError

app = Flask(__name__)
client = AtlaSentClient(api_key="ask_live_...")

@app.post("/modify-record")
def modify_record():
    try:
        permit = client.protect(
            agent="flask-agent",
            action="modify_patient_record",
            context={"patient_id": request.json["patient_id"]},
        )
    except AtlaSentDeniedError as exc:
        abort(403, description=exc.reason)
    except AtlaSentError as exc:
        abort(503, description=str(exc))
    return jsonify(permit_id=permit.permit_id, audit_hash=permit.audit_hash)
```

Decorator shortcuts — `atlasent_guard` for sync views,
`async_atlasent_guard` for async ones — remain available for the
pre-`protect()` `gate()` + `GateResult` idiom. See
[`examples/fastapi_integration.py`](./examples/fastapi_integration.py)
and [`examples/flask_integration.py`](./examples/flask_integration.py).

## configure()

```python
import atlasent

atlasent.configure(
    api_key="ask_live_...",               # else reads ATLASENT_API_KEY
    base_url="https://api.atlasent.io",   # default
)
```

Or pass the same settings to `AtlaSentClient(...)` / `AsyncAtlaSentClient(...)`
directly for per-client configuration:

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

## Lower-level primitives

`protect()` is built on top of the raw two-endpoint surface. If you
need to branch on the decision rather than raise, use these directly:

- `client.evaluate(action, agent, context)` — policy decision;
  raises `AtlaSentDenied` on deny, otherwise returns
  `EvaluateResult`.
- `client.verify(permit_token, ...)` — verify a previously-issued
  permit end-to-end.
- `client.gate(action, agent, context)` — evaluate + verify; returns
  a `GateResult` with both response objects.
- `authorize(agent, action, context)` — data-not-exception
  variant: returns an `AuthorizationResult` with `permitted: bool`
  instead of raising on deny. Prefer `protect()` unless you have a
  specific reason to branch on a return value.

## Design choices

- **Fail-closed by construction.** `protect()` either returns a
  `Permit` or raises. No ambiguous return values, no silent permits.
- **Sync + async feature parity.** Every public method exists on
  both `AtlaSentClient` and `AsyncAtlaSentClient`.
- **Wire-compatible with the TypeScript SDK.** A permit issued by
  one SDK verifies from the other.
- **PEP 561 typed.** Ships a `py.typed` marker; every public
  function and type is annotated.

## API endpoints

The SDK calls:

- `POST https://api.atlasent.io/v1-evaluate`
- `POST https://api.atlasent.io/v1-verify-permit`

Override with the `base_url` argument.

## Requirements

- Python **3.10+** (for `str | None` unions and
  `datetime.UTC`).
- `httpx >= 0.24`, `pydantic >= 2.0`.

## Related

- **TypeScript SDK**: [`../typescript/`](../typescript/README.md).
  Same wire contract, same fail-closed philosophy, same
  `protect()` verb.
- **Shared contract**: [`../contract/`](../contract/) — schemas,
  vectors, and the CI drift detector that keeps both SDKs honest.

## Get an API key

Sign up at [atlasent.io](https://atlasent.io) → Settings → API Keys.

## License

MIT — see [LICENSE](LICENSE).
