# `@atlasent/sentry-preview` — PREVIEW, DO NOT USE IN PRODUCTION

> **Status:** DRAFT v2 preview. Marked `private: true` until v2 GA.
> Every export is subject to change without semver discipline.

Sentry adapter for AtlaSent. Wraps an `AtlaSentClient` instance
with automatic breadcrumb emission around each authorization call,
plus optional automatic exception capture. Sibling of
`@atlasent/otel-preview` (which targets the OpenTelemetry side of
PR #57's "Sentry / OpenTelemetry breadcrumbs" ergonomics line).

## Why a separate preview package?

1. **Optional peer dep**: not every customer uses Sentry. Keeping
   the wrapper out of `@atlasent/sdk`'s main surface means non-
   Sentry users don't pull `@sentry/core`.
2. **No v1 changes**: this package wraps v1's public API but
   doesn't modify it. v1 ships unchanged.
3. **v2-track**: at v2 GA, the eventual `protect()` callback flow
   (PR #60) integrates here so each Pillar 9 lifecycle event
   becomes a breadcrumb.

## What's in here

```ts
import { AtlaSentClient } from "@atlasent/sdk";
import { withSentry } from "@atlasent/sentry-preview";
import * as Sentry from "@sentry/node";

Sentry.init({ dsn: "..." });

const client = withSentry(new AtlaSentClient({ apiKey }), {
  // Optional: extra fields added to every breadcrumb's `data`.
  extraData: { service: "deploy-bot" },
  // Optional: also call Sentry.captureException(err) on throw.
  // Defaults to false — most apps capture exceptions at a higher
  // layer; flipping this on opts in to per-call capture.
  captureErrors: true,
});

await client.evaluate({ agent, action, context });
// → Sentry breadcrumb:
//     { category: "atlasent", message: "evaluate", level: "info",
//       data: { agent, action, decision, permit_id, audit_hash, ...service } }
```

`withSentry(client, options)` returns an object with the same
public methods as `AtlaSentClient` (`evaluate`, `verifyPermit`,
`protect`, `keySelf`, `listAuditEvents`, `createAuditExport`).
Each method emits one breadcrumb per invocation:

| Method | Breadcrumb category | message | data on success | data on error |
|---|---|---|---|---|
| `evaluate` | `atlasent` | `evaluate` | `agent`, `action`, `decision`, `permit_id`, `audit_hash` | `agent`, `action`, `error_code`, `request_id` |
| `verifyPermit` | `atlasent` | `verify_permit` | `permit_id`, `verified` | `permit_id`, `error_code`, `request_id` |
| `protect` | `atlasent` | `protect` | `agent`, `action`, `permit_id`, `audit_hash` | `agent`, `action`, `error_code`, `request_id` |
| `keySelf` | `atlasent` | `key_self` | `key_id`, `environment` | `error_code`, `request_id` |
| `listAuditEvents` | `atlasent` | `list_audit_events` | `event_count` | `error_code`, `request_id` |
| `createAuditExport` | `atlasent` | `create_audit_export` | `export_id`, `event_count` | `error_code`, `request_id` |

`level` is `"info"` on success, `"error"` on failure. `extraData`
fields layer onto every breadcrumb.

`wrapProtect({ protect, ... })` covers the top-level v1 `protect()`
function.

## What's NOT in here

- **OpenTelemetry integration.** Lives in
  [`@atlasent/otel-preview`](../otel/README.md). Use both side-by-
  side; they don't conflict.
- **Sentry performance monitoring spans.** Sentry's tracing API
  duplicates what OTel does — pick one. If you want both
  breadcrumbs (Sentry) AND spans (OTel), wrap with both adapters
  in series.
- **Custom transports / DSN init.** This wrapper assumes
  `Sentry.init(...)` has already run upstream of your code.

## Installation (dev)

```bash
cd typescript/packages/sentry
npm install
npm test
```

Peer deps: `@atlasent/sdk` (v1) and `@sentry/core`. The preview's
devDependencies wire `@atlasent/sdk` to the local v1 package via
`file:../../` since v1 hasn't published yet — when v1 ships to
npm, customers install both peers normally.
