# `@atlasent/otel-preview` — PREVIEW, DO NOT USE IN PRODUCTION

> **Status:** DRAFT v2 preview. Marked `private: true` until v2 GA.
> Every export is subject to change without semver discipline.

OpenTelemetry adapter for AtlaSent. Wraps an `AtlaSentClient`
instance with automatic span creation around each authorization
call. Pillar: ergonomics — see PR #57's "Sentry / OpenTelemetry
breadcrumbs" line in `docs/V2_PLAN.md`.

## Why a separate preview package?

1. **Optional peer dep**: not every customer uses OTel. Keeping the
   wrapper out of `@atlasent/sdk`'s main surface means non-OTel
   users don't pull `@opentelemetry/api`.
2. **No v1 changes**: this package wraps v1's public API but doesn't
   modify it. v1 ships unchanged.
3. **v2-track**: at v2 GA, the eventual `protect()` callback flow
   (PR #60) integrates here so each Pillar 9 lifecycle event
   becomes a span event.

## What's in here

```ts
import { AtlaSentClient } from "@atlasent/sdk";
import { withOtel } from "@atlasent/otel-preview";
import { trace } from "@opentelemetry/api";

const tracer = trace.getTracer("my-app");
const client = withOtel(new AtlaSentClient({ apiKey }), {
  tracer,
  // Optional: extra attributes added to every span.
  attributes: { "service.name": "deploy-bot" },
});

await client.evaluate({ agent, action, context });
// → span "atlasent.evaluate" with attributes:
//     atlasent.agent, atlasent.action, atlasent.decision,
//     atlasent.permit_id, atlasent.audit_hash
```

`withOtel(client, options)` returns an object with the same public
methods as `AtlaSentClient` (`evaluate`, `verifyPermit`, `protect`,
`keySelf`, `listAuditEvents`, `createAuditExport`). Each method
runs the original call inside a span:

| Method | Span name | Pre-call attrs | On success | On error |
|---|---|---|---|---|
| `evaluate` | `atlasent.evaluate` | `atlasent.agent`, `atlasent.action` | `atlasent.decision`, `atlasent.permit_id`, `atlasent.audit_hash` | `error.code`, span status ERROR |
| `verifyPermit` | `atlasent.verify_permit` | `atlasent.permit_id` | `atlasent.verified` | same |
| `protect` | `atlasent.protect` | `atlasent.agent`, `atlasent.action` | `atlasent.permit_id`, `atlasent.audit_hash` | same (treats `AtlaSentDeniedError` as ERROR) |
| `keySelf` | `atlasent.key_self` | — | `atlasent.key_id`, `atlasent.environment` | same |
| `listAuditEvents` | `atlasent.list_audit_events` | — | `atlasent.event_count` | same |
| `createAuditExport` | `atlasent.create_audit_export` | — | `atlasent.export_id`, `atlasent.event_count` | same |

## What's NOT in here

- **Sentry integration.** Same approach (a separate `@atlasent/sentry-preview`)
  applies, but Sentry's API surface is independent enough that we keep them
  in separate packages. Tracked in PR #57's ergonomics list.
- **Metrics / logs.** Spans only — metrics and structured logs layer on
  top of the same wrapper at v2 GA.
- **Async vs. sync awareness for retries.** Each method invocation creates
  one span; v1's internal retry loop is opaque to OTel callers. v2 may
  surface retry attempts as span events at GA.

## Installation (dev)

```bash
cd typescript/packages/otel
npm install
npm test
```

Peer deps: `@atlasent/sdk` (v1) and `@opentelemetry/api`. The
preview's devDependencies wire `@atlasent/sdk` to the local v1
package via `file:../../` since v1 hasn't published yet — when v1
ships to npm, customers install both peers normally.
