# atlasent-llamaindex

[![PyPI](https://img.shields.io/pypi/v/atlasent-llamaindex.svg)](https://pypi.org/project/atlasent-llamaindex/)

AtlaSent authorization wrapper (guardrails / AI agent gating) for LlamaIndex
tools. Wraps any Python callable with authorize-before-execute semantics:

1. `client.protect()` — evaluate the policy engine + verify the permit (fail-closed)
2. Execute the original function — only when both pass

Zero dependency on `llama-index` or `llama-index-core`. The wrapped callable
keeps the original `__name__`, `__doc__`, and signature, so it drops straight
into any LlamaIndex tool factory.

## Install

```bash
pip install atlasent-llamaindex atlasent
```

Python 3.10+ required.

## Quickstart

```python
from atlasent import AtlaSentClient
from atlasent_llamaindex import with_llamaindex_guard
from llama_index.core.tools import FunctionTool

client = AtlaSentClient(api_key="ask_live_...")

def search(query: str) -> str:
    """Search the knowledge base."""
    return f"Results for: {query}"

# Wrap the function — AtlaSent evaluates before every call
guarded_search = with_llamaindex_guard(
    search,
    client,
    agent="service:knowledge-bot",
    # agent.tool.invoke (the default action) requires `environment`
    extra_context={"environment": "production"},
)

# Pass to LlamaIndex exactly as you would the original function
tool = FunctionTool.from_defaults(fn=guarded_search)
```

If the policy denies the action, `AtlaSentDeniedError` is raised before
`search()` is called.

## Async usage

```python
from atlasent import AsyncAtlaSentClient
from atlasent_llamaindex import async_with_llamaindex_guard

aclient = AsyncAtlaSentClient(api_key="ask_live_...")

async def fetch_document(doc_id: str) -> dict:
    """Fetch a document from the index."""
    return {"id": doc_id, "content": "..."}

guarded_fetch = async_with_llamaindex_guard(
    fetch_document, aclient, agent="service:retrieval-agent"
)

# Async FunctionTool
from llama_index.core.tools import AsyncBaseTool
tool = FunctionTool.from_defaults(async_fn=guarded_fetch)
```

## Configuration

### `with_llamaindex_guard(func, client, *, agent, action=None, extra_context=None, on_deny="throw")`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `func` | callable | required | The sync callable to wrap |
| `client` | `AtlaSentClient` | required | Authenticated AtlaSent client |
| `agent` | `str` | required | Agent identifier (e.g. `"service:bot"`) |
| `action` | `str` | `"agent.tool.invoke"` | Action type for policy evaluation (see [Action and context](#action-and-context)) |
| `extra_context` | `dict` | `{}` | Additional context merged into every evaluation. Must carry `environment` for the default `agent.tool.invoke` action. Cannot override `tool`. |
| `on_deny` | `"throw"` \| `"tool-result"` | `"throw"` | What to do when denied |

### `async_with_llamaindex_guard(func, client, *, agent, action=None, extra_context=None, on_deny="throw")`

Same parameters as above, wraps an async callable instead.

## Action and context

Every guarded call is evaluated as **`agent.tool.invoke`** (Canon ACT-0029,
exported as `DEFAULT_TOOL_ACTION`) unless you pass `action`. That is the
canonical action for an agent invoking a tool. Earlier builds defaulted the
action to `func.__name__` (e.g. `"search"`), which names no runtime action
class, so every call was denied.

The guard always sends the wrapped function's `__name__` as
`context["tool"]`, alongside `context["tool_input"]`. `tool` is written after
`extra_context` is copied, so `extra_context` cannot relabel a call as a
different tool (your `extra_context` dict is not mutated).

**The `agent.tool.invoke` action class requires two context inputs: `tool`
and `environment`.** The guard supplies `tool`. It does **not** invent an
`environment` -- pass it yourself, or the runtime denies the call for a
missing required input:

```python
guarded = with_llamaindex_guard(
    search,
    client,
    agent="service:bot",
    extra_context={"environment": "production"},
    state_snapshot={"source": "my-service", "complete": True},
)
```

To keep a per-tool action class of your own, pass `action="..."`; it is used
exactly as before, and must name an action class that exists in your org.

**Target binding is not applied.** `AtlaSentClient.protect()` takes no
`resource_id` / `target_id`, so the permit is not bound to the specific tool
the way `@atlasent/mcp-server`'s tool gate binds it. `context["tool"]` is
policy input and audit evidence, not a verify-time target check.

## Error handling

### `on_deny="throw"` (default)

`AtlaSentDeniedError` is raised when the policy denies the action:

```python
from atlasent.exceptions import AtlaSentDeniedError

try:
    result = guarded_search(query="sensitive data")
except AtlaSentDeniedError as e:
    print(f"Denied: {e.reason}")
    print(f"Evaluation ID: {e.evaluation_id}")  # for audit lookup
```

### `on_deny="tool-result"`

Returns a `DenialResult` object instead of raising. Useful when the LLM
should see and reason about the denial:

```python
guarded = with_llamaindex_guard(
    search, client, agent="service:bot", on_deny="tool-result"
)

result = guarded(query="restricted content")
if hasattr(result, "denied") and result.denied:
    print(f"Action denied: {result.reason}")
```

`DenialResult` attributes: `.denied` (always `True`), `.decision`, `.evaluation_id`, `.reason`, `.audit_hash`.

## Permit metadata on results

When the underlying function returns a `dict`, the guard annotates it with
permit metadata:

```python
# Your function returns: {"content": "document text"}
# Guard adds:
{
    "content": "document text",
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

`atlasent-llamaindex` 1.5.1 · Python ≥ 3.10 · `atlasent` ≥ 2.15.0 peer dependency

## License

Apache-2.0 — see [LICENSE](LICENSE)
