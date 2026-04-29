# `atlasent-sentry-preview` — PREVIEW, DO NOT USE IN PRODUCTION

> **Status:** DRAFT v2 preview. Marked alpha (`2.0.0a0`). Every
> export is subject to change without semver discipline.

Python sibling of
[`@atlasent/sentry-preview`](../../typescript/packages/sentry/).
Wraps v1's `AtlaSentClient` / `AsyncAtlaSentClient` with automatic
Sentry breadcrumb emission around each authorization call, plus
optional automatic exception capture.

## Why a separate preview package?

1. **Optional dep**: not every customer uses Sentry. Keeping the
   wrapper out of `atlasent`'s main surface means non-Sentry users
   don't pull `sentry-sdk`.
2. **No v1 changes**: this package wraps v1's public API but
   doesn't modify it. v1 ships unchanged.
3. **v2-track**: at v2 GA, the eventual `protect()` callback flow
   (PR #60) integrates here so each Pillar 9 lifecycle event
   becomes a breadcrumb.

## What's in here

```python
from atlasent import AtlaSentClient
from atlasent_sentry_preview import with_sentry
import sentry_sdk

sentry_sdk.init(dsn="...")

client = with_sentry(
    AtlaSentClient(api_key="..."),
    extra_data={"service": "deploy-bot"},
    capture_errors=True,
)

# Each call emits a Sentry breadcrumb automatically.
client.evaluate("deploy", "deploy-bot", {"commit": commit})
```

`with_sentry(client, extra_data=None, capture_errors=False)` returns
an object with the same public methods as the wrapped client
(`evaluate`, `verify`, `gate`, `protect`, `authorize`, `key_self`,
`list_audit_events`, `create_audit_export`). Each method emits one
breadcrumb per invocation:

| Method | message | data on success | data on error |
|---|---|---|---|
| `evaluate` | `evaluate` | `agent`, `action`, `permit_token`, `audit_hash` | `agent`, `action`, `error_code`, `request_id`, `error_message` |
| `verify` | `verify_permit` | `permit_token`, `verified` | `permit_token`, `error_code`, `request_id` |
| `protect` | `protect` | `agent`, `action`, `permit_id`, `audit_hash` | same |
| `authorize` | `authorize` | `agent`, `action`, `permitted`, `permit_token` | same |
| `gate` | `gate` | `action`, `agent` | same |
| `key_self` | `key_self` | `key_id`, `environment` | same |
| `list_audit_events` | `list_audit_events` | `event_count` | same |
| `create_audit_export` | `create_audit_export` | `export_id`, `event_count` | same |

`category` is always `"atlasent"` for filtering / search in Sentry.
`level` is `"info"` on success, `"error"` on failure. `extra_data`
fields layer onto every breadcrumb.

`with_async_sentry(...)` covers `AsyncAtlaSentClient` with the
same shape; `with_sentry_protect(protect_fn, ...)` covers the
top-level `atlasent.protect()` function.

## What's NOT in here

- **OpenTelemetry integration.** Lives in
  [`atlasent-otel-preview`](../atlasent_otel_preview/README.md).
  Use both side-by-side; they don't conflict.
- **Sentry performance monitoring spans.** Sentry's tracing API
  duplicates what OTel does — pick one. If you want both
  breadcrumbs (Sentry) AND spans (OTel), wrap with both adapters
  in series.

## Installation (dev)

```bash
cd python/atlasent_sentry_preview
pip install -e '.[dev]'
pytest
```

Hard runtime deps: `atlasent>=1.4.0` (bumps to `>=1.5.0` after
PR #83 merges) and `sentry-sdk>=1.40.0`.
