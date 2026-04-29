# `atlasent-otel-preview` — PREVIEW, DO NOT USE IN PRODUCTION

> **Status:** DRAFT v2 preview. Marked alpha (`2.0.0a0`) and
> classified `Pre-Alpha`. Every export is subject to change without
> semver discipline.

Python sibling of
[`@atlasent/otel-preview`](../../typescript/packages/otel/). Wraps
v1's `AtlaSentClient` / `AsyncAtlaSentClient` with automatic
OpenTelemetry span creation around each authorization call.

## Why a separate preview package?

1. **Optional dep**: not every customer uses OTel. Keeping the
   wrapper out of `atlasent`'s main surface means non-OTel users
   don't pull `opentelemetry-api`.
2. **No v1 changes**: this package wraps v1's public API but
   doesn't modify it. v1 ships unchanged.
3. **v2-track**: at v2 GA, the eventual `protect()` callback flow
   (PR #60) integrates here so each Pillar 9 lifecycle event
   becomes a span event.

## What's in here

```python
from atlasent import AtlaSentClient
from atlasent_otel_preview import with_otel
from opentelemetry import trace

tracer = trace.get_tracer("my-app")
client = with_otel(
    AtlaSentClient(api_key="..."),
    tracer=tracer,
    attributes={"service.name": "deploy-bot"},
)

# Each method emits a span automatically.
client.evaluate("deploy", "deploy-bot", {"commit": commit})
```

`with_otel(client, tracer, attributes=None, span_name_prefix="atlasent.")`
returns an object with the same public methods as the wrapped
client (`evaluate`, `verify`, `gate`, `protect`, `authorize`,
`key_self`, `list_audit_events`, `create_audit_export`). Each
method runs the original call inside a span:

| Method | Span name | Pre-call attrs | On success | On error |
|---|---|---|---|---|
| `evaluate` | `atlasent.evaluate` | `atlasent.agent`, `atlasent.action` | `atlasent.permit_token`, `atlasent.audit_hash` | `atlasent.error_code`, `atlasent.request_id`, status ERROR |
| `verify` | `atlasent.verify_permit` | `atlasent.permit_token` | `atlasent.verified` | same |
| `protect` | `atlasent.protect` | `atlasent.agent`, `atlasent.action` | `atlasent.permit_id`, `atlasent.audit_hash` | same |
| `authorize` | `atlasent.authorize` | `atlasent.agent`, `atlasent.action` | `atlasent.permitted`, `atlasent.permit_token` | same |
| `key_self` | `atlasent.key_self` | — | `atlasent.key_id`, `atlasent.environment` | same |
| `list_audit_events` | `atlasent.list_audit_events` | — | `atlasent.event_count` | same |
| `create_audit_export` | `atlasent.create_audit_export` | — | `atlasent.export_id`, `atlasent.event_count` | same |

`with_async_otel(...)` covers `AsyncAtlaSentClient` with the same
shape — span lifecycle handles `await` correctly.

## What's NOT in here

- **Sentry integration.** Same approach (a separate
  `atlasent-sentry-preview`) applies. Tracked in PR #57's
  ergonomics list.
- **Metrics / logs.** Spans only — metrics and structured logs
  layer on top of the same wrapper at v2 GA.

## Installation (dev)

```bash
cd python/atlasent_otel_preview
pip install -e '.[dev]'
pytest
```

Hard runtime deps: `atlasent>=1.5.0` and `opentelemetry-api>=1.20.0`.
