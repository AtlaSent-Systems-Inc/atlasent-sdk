# atlasent-langchain

[![PyPI](https://img.shields.io/pypi/v/atlasent-langchain.svg)](https://pypi.org/project/atlasent-langchain/)

AtlaSent authorization wrapper (guardrails / AI agent gating) for LangChain
tools. Wraps any Python callable with authorize-before-execute semantics:

1. `client.protect()` — evaluate the policy engine + verify the permit (fail-closed)
2. Execute the original function — only when both pass

Zero dependency on `langchain` or `langchain-core`. The wrapped callable keeps
the original `__name__`, `__doc__`, and signature, so it drops straight into
any LangChain tool factory.

## Install

```bash
pip install atlasent-langchain atlasent
```

Python 3.10+ required.

## Quickstart

```python
from atlasent import AtlaSentClient
from atlasent_langchain import with_langchain_guard
from langchain_core.tools import tool

client = AtlaSentClient(api_key="ask_live_...")

def search(query: str) -> str:
    """Search the knowledge base."""
    return f"Results for: {query}"

# Wrap the function — AtlaSent evaluates before every call
guarded_search = with_langchain_guard(search, client, agent="service:analytics-bot")

# Pass to LangChain exactly as you would the original function
langchain_tool = tool(guarded_search)
```

If the policy denies the action, `AtlaSentDeniedError` is raised before
`search()` is called.

## Async usage

```python
from atlasent import AsyncAtlaSentClient
from atlasent_langchain import async_with_langchain_guard

aclient = AsyncAtlaSentClient(api_key="ask_live_...")

async def fetch_record(record_id: str) -> dict:
    """Fetch a patient record."""
    return {"id": record_id, "data": "..."}

guarded_fetch = async_with_llamaindex_guard(
    fetch_record, aclient, agent="service:clinical-bot"
)

# StructuredTool with async coroutine
from langchain_core.tools import StructuredTool
tool = StructuredTool.from_function(coroutine=guarded_fetch)
```

## Configuration

### `with_langchain_guard(func, client, *, agent, action=None, extra_context=None, on_deny="throw")`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `func` | callable | required | The sync callable to wrap |
| `client` | `AtlaSentClient` | required | Authenticated AtlaSent client |
| `agent` | `str` | required | Agent identifier (e.g. `"service:bot"`) |
| `action` | `str` | `func.__name__` | Action type for policy evaluation |
| `extra_context` | `dict` | `{}` | Additional context merged into every evaluation |
| `on_deny` | `"throw"` \| `"tool-result"` | `"throw"` | What to do when denied |

### `async_with_langchain_guard(func, client, *, agent, action=None, extra_context=None, on_deny="throw")`

Same parameters as above, wraps an async callable instead.

## Error handling

### `on_deny="throw"` (default)

`AtlaSentDeniedError` is raised when the policy denies the action. The tool
returns an error to LangChain as if the underlying function raised:

```python
from atlasent.exceptions import AtlaSentDeniedError

try:
    result = guarded_search(query="patient data")
except AtlaSentDeniedError as e:
    print(f"Denied: {e.reason}")  # reason is human-readable
    print(f"Evaluation ID: {e.evaluation_id}")  # for audit lookup
```

### `on_deny="tool-result"`

Returns a `DenialResult` object instead of raising. Useful when the LLM
should see and reason about the denial:

```python
guarded = with_langchain_guard(
    search, client, agent="service:bot", on_deny="tool-result"
)

result = guarded(query="sensitive data")
if hasattr(result, "denied") and result.denied:
    print(f"Action denied: {result.reason}")
```

`DenialResult` attributes: `.denied` (always `True`), `.decision`, `.evaluation_id`, `.reason`, `.audit_hash`.

## Permit metadata on results

When the underlying function returns a `dict`, the guard annotates it with
permit metadata:

```python
# Your function returns: {"result": "data"}
# Guard adds:
{
    "result": "data",
    "_atlasent_permit_id": "pt_...",
    "_atlasent_audit_hash": "sha256:...",
}
```

Non-dict return values are passed through unmodified.

## Configuration reference

Set up the `AtlaSentClient` with your API key and base URL:

```python
client = AtlaSentClient(
    api_key="ask_live_...",  # from AtlaSent console → Settings → API Keys
    base_url="https://kttccumlnmdtupgbyfue.supabase.co/functions/v1",
)
```

Environment variable alternative: `ATLASENT_API_KEY` and `ATLASENT_BASE_URL`.

## Version

`atlasent-langchain` 1.5.1 · Python ≥ 3.10 · `atlasent` ≥ 2.15.0 peer dependency

## License

Apache-2.0 — see [LICENSE](LICENSE)
