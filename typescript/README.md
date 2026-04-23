# @atlasent/sdk

**Execution-time authorization for AI agents.** One call before a sensitive
action runs. Fail-closed by design — no action proceeds without an explicit,
verified permit.

```bash
npm i @atlasent/sdk
```

## Quickstart

```ts
import atlasent from "@atlasent/sdk";

const permit = await atlasent.protect({
  agent: "deploy-bot",
  action: "deploy_to_production",
  context: { commit, approver },
});
// If we got here, the action is authorized. Proceed.
```

Set `ATLASENT_API_KEY` in the environment, or call
`atlasent.configure({ apiKey })`. That's the whole setup.

## The protect() contract

`atlasent.protect()` is the category primitive. On allow, it returns
a verified `Permit`. On anything else, it **throws**:

| Outcome                                  | Throws                                      |
|------------------------------------------|---------------------------------------------|
| Policy `DENY`                            | `AtlaSentDeniedError`                       |
| Permit failed verification               | `AtlaSentDeniedError`                       |
| HTTP 401 / 403 / 4xx / 5xx               | `AtlaSentError` (with `.code`)              |
| Timeout / network failure                | `AtlaSentError` (`code: "timeout" / "network"`) |
| Rate limit (429)                         | `AtlaSentError` (`code: "rate_limited"`, `.retryAfterMs`) |

There is no `{ permitted: false }` return path to forget. The action
cannot execute unless a `Permit` object is in hand.

```ts
try {
  const permit = await atlasent.protect({ agent, action, context });
  // Run the action. permit.permitId + permit.auditHash go in your log.
} catch (err) {
  if (err instanceof AtlaSentDeniedError) {
    // Policy said no. err.decision, err.reason, err.evaluationId.
  } else if (err instanceof AtlaSentError) {
    // Transport / auth / server failure. err.code, err.requestId.
  }
}
```

Both error types share `requestId` for support escalation.

## Framework integration: Hono

Drop-in route protection via the `@atlasent/sdk/hono` subpath:

```ts
import { Hono } from "hono";
import { atlaSentGuard, atlaSentErrorHandler } from "@atlasent/sdk/hono";

const app = new Hono();

// One place to map every AtlaSent failure to an HTTP response.
// Defaults: AtlaSentDeniedError → 403, AtlaSentError → 503.
app.onError(atlaSentErrorHandler());

app.post(
  "/deploy/:service",
  atlaSentGuard({
    action: (c) => `deploy_${c.req.param("service")}`,
    agent: (c) => c.req.header("x-agent-id") ?? "anonymous",
    context: async (c) => ({
      commit: (await c.req.json<{ commit: string }>()).commit,
      approver: c.req.header("x-approver") ?? "unknown",
    }),
  }),
  (c) => {
    const permit = c.get("atlasent"); // type-safe via Variables
    return c.json({ ok: true, permitId: permit.permitId });
  },
);
```

- `action`, `agent`, and `context` take static values **or** functions
  of the Hono `Context` for per-request resolution (route params,
  auth headers, parsed body).
- On allow, the verified `Permit` is stashed on `c.get("atlasent")`
  (or a custom `key` of your choice).
- On deny or error the guard **throws**; `atlaSentErrorHandler()`
  translates once, at the app level.
- `hono` is an **optional** peer dependency — you only pull it in if
  you import from `@atlasent/sdk/hono`.

See [`examples/hono-guard.ts`](./examples/hono-guard.ts) for a
complete working app.

## `configure()`

```ts
import atlasent from "@atlasent/sdk";

atlasent.configure({
  apiKey: "ask_live_...",               // else reads ATLASENT_API_KEY
  baseUrl: "https://api.atlasent.io",   // default
  timeoutMs: 10_000,                    // default, per-request
  fetch: customFetch,                   // default: globalThis.fetch
});
```

Calling `configure()` again replaces the process-wide singleton
`protect()` uses. Not required — if `ATLASENT_API_KEY` is in the
env, `protect()` works with zero setup.

## Error taxonomy

One exception family, two meanings:

```ts
import { AtlaSentError, AtlaSentDeniedError } from "@atlasent/sdk";

// AtlaSentDeniedError extends AtlaSentError — catching the base
// catches denials too.
catch (err) {
  if (err instanceof AtlaSentDeniedError) {
    err.decision;      // "deny" | "hold" | "escalate"
    err.evaluationId;  // opaque decision id
    err.reason;        // human-readable, if the policy engine sent one
    err.auditHash;     // hash-chained audit trail entry
  } else if (err instanceof AtlaSentError) {
    err.code;          // invalid_api_key | forbidden | rate_limited
                       // | timeout | network | bad_response
                       // | bad_request | server_error
    err.status;        // HTTP status, or undefined for transport errors
    err.requestId;     // X-Request-ID the SDK sent
    err.retryAfterMs;  // parsed Retry-After on rate_limited
  }
}
```

## Lower-level primitives

If you need the raw policy decision (data, not an exception),
`AtlaSentClient` exposes the two-endpoint surface directly:

```ts
import { AtlaSentClient } from "@atlasent/sdk";

const client = new AtlaSentClient({ apiKey: process.env.ATLASENT_API_KEY! });

// evaluate() returns data; a clean DENY is NOT thrown.
const evaluation = await client.evaluate({ agent, action, context });
if (evaluation.decision === "ALLOW") {
  const verification = await client.verifyPermit({ permitId: evaluation.permitId });
  // ...
}
```

`protect()` is built on top of these two methods; use them directly
when you want to branch on the decision rather than throw.

## Design choices

- **Fail-closed by construction.** `protect()` either returns a
  `Permit` or throws. No ambiguous return values, no silent permits.
- **Default export defines the category.** `import atlasent from
  "@atlasent/sdk"` and `atlasent.protect()` — matching the Stripe /
  Auth0 / Supabase idiom.
- **Native `fetch` only.** No axios, no polyfills. Node 20+ has
  everything we need.
- **Zero runtime dependencies** on the default entry. Hono guard
  requires `hono` as an optional peer.
- **Wire-compatible with the Python SDK.** Permits from one SDK
  verify from the other.

## Requirements

- Node.js **20** or newer (native `fetch`, `AbortSignal.timeout`,
  `crypto.randomUUID`).
- TypeScript **5.0+** recommended for the best inference.

## Related

- **Python SDK**: [`../python/`](../python/README.md). Same wire
  contract, same fail-closed philosophy.
- **Shared contract**: [`../contract/`](../contract/) — schemas,
  vectors, and the CI drift detector that keeps both SDKs honest.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
