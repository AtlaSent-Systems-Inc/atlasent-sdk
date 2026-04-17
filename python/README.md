# atlasent-python

Python SDK for [AtlaSent](https://atlasent.io) — authorization as a service.

## Install

```bash
pip install atlasent
# or
uv add atlasent
```

## Quick start

```python
from atlasent import authorize, AtlaSentDeniedError

try:
    result = authorize(
        agent="clinical-data-agent",
        action="modify_patient_record",
        context={"patient_id": "P-001", "record_type": "medication"},
    )
    if result.permitted:
        print("Access granted")
except AtlaSentDeniedError as e:
    print(f"Denied: {e.code}")
```

## Async

```python
from atlasent import async_authorize

result = await async_authorize(
    agent="my-agent",
    action="data.export",
    context={"environment": "production"},
)
```

## Guard decorators

```python
from atlasent import atlasent_guard, async_atlasent_guard

@atlasent_guard(action="production.deploy")
def deploy(sha: str, env: str):
    ...

@async_atlasent_guard(action="model.fine-tune")
async def fine_tune(model_id: str):
    ...
```

## Configuration

| Env var | Default |
|---|---|
| `ATLASENT_API_KEY` | required |
| `ATLASENT_BASE_URL` | `https://api.atlasent.io` |
| `ATLASENT_TIMEOUT` | `10` (seconds) |

## License

MIT
