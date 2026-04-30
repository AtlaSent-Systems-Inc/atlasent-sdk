# @atlasent/sdk

Execution-time authorization for AI agents, in TypeScript. Two methods, zero runtime dependencies, one function call per decision.

```bash
npm i @atlasent/sdk
```

## Quickstart

```ts
import { AtlaSentClient } from "@atlasent/sdk";

const client = new AtlaSentClient({ apiKey: process.env.ATLASENT_API_KEY! });

const result = await client.evaluate({
  agent: "clinical-data-agent",
  action: "modify_patient_record",
  context: { user: "dr_smith", environment: "production" },
});

if (result.decision === "ALLOW") {
  // execute the action
} else {
  console.warn("Blocked:", result.reason);
}
```

That's it. `evaluate()` calls the AtlaSent policy engine, generates a hash-chained audit entry (21 CFR Part 11 / GxP-ready), and returns a result you branch on. A clean `DENY` is **not** thrown — network / server / auth failures are.

## Two methods, that's the whole surface

```ts
client.evaluate({ agent, action, context? })
  // → { decision: "ALLOW" | "DENY", permitId, reason, auditHash, timestamp }

client.verifyPermit({ permitId, agent?, action?, context? })
  // → { verified, outcome, permitHash, timestamp }
```

`verifyPermit()` confirms a previously-issued permit end-to-end — use it as a second-factor gate (e.g., in a CI deploy pipeline before side-effects run).

## CI deploy-gate pattern

```ts
import { AtlaSentClient } from "@atlasent/sdk";

const client = new AtlaSentClient({ apiKey: process.env.ATLASENT_API_KEY! });

const evaluation = await client.evaluate({
  agent: "ci-deploy-bot",
  action: "deploy_to_production",
  context: { service: "billing-api", commit: process.env.GIT_SHA },
});

if (evaluation.decision !== "ALLOW") {
  console.error("Deploy blocked:", evaluation.reason);
  process.exit(1);
}

const verification = await client.verifyPermit({
  permitId: evaluation.permitId,
});

if (!verification.verified) {
  console.error("Permit verification failed — aborting");
  process.exit(1);
}

// runDeploy();
```

See [`examples/deploy-gate.ts`](./examples/deploy-gate.ts) for a complete CI-shaped script.

## Constructor options

```ts
new AtlaSentClient({
  apiKey: "ask_live_...",           // required
  baseUrl: "https://api.atlasent.io", // default
  timeoutMs: 10_000,                  // default — per-request
  fetch: customFetch,                 // default: globalThis.fetch
});
```

## Error handling

The SDK throws exactly one error type — `AtlaSentError` — with a flat shape that mirrors Stripe / Octokit / Supabase conventions:

```ts
import { AtlaSentError } from "@atlasent/sdk";

try {
  await client.evaluate({ agent: "a", action: "b" });
} catch (err) {
  if (err instanceof AtlaSentError) {
    console.error(err.code, err.status, err.requestId, err.retryAfterMs);
  }
}
```

| `err.code`         | When it's thrown                                        |
|--------------------|---------------------------------------------------------|
| `invalid_api_key`  | HTTP 401                                                |
| `forbidden`        | HTTP 403                                                |
| `rate_limited`     | HTTP 429 (check `err.retryAfterMs`)                     |
| `bad_request`      | HTTP 4xx (other than 401/403/429)                       |
| `server_error`     | HTTP 5xx                                                |
| `timeout`          | `timeoutMs` exceeded                                    |
| `network`          | DNS / connection failure, fetch threw                   |
| `bad_response`     | non-JSON body or missing required fields                |

Every `AtlaSentError` carries `err.requestId` — the UUID the SDK sent as `X-Request-ID`, correlatable in your server logs.

## Design choices

- **Fail-closed.** A clean `DENY` is returned so your code explicitly handles it; every other failure throws, so no action proceeds silently.
- **Native `fetch` only.** No axios, no polyfills. Node 20+ has everything we need.
- **Zero runtime dependencies.** Strongly typed via plain TS interfaces.
- **Bearer-token auth.** `Authorization: Bearer <apiKey>` so request-body logs never capture the key. (The SDK also includes `api_key` in the body for wire compat with the current policy engine; that will be removed once the server drops body-based auth.)

## Requirements

- Node.js **20** or newer (native `fetch`, `AbortSignal.timeout`, `crypto.randomUUID`).
- **Browser:** Chrome 103+, Firefox 100+, Safari 16+, Edge 103+. The SDK uses
  `AbortSignal.timeout` for per-request deadlines — the constructor throws a
  clear `AtlaSentError(code: "network")` on runtimes that lack it so the failure
  is loud rather than silent.
- TypeScript **5.0+** for best type-inference ergonomics (older is fine — types are plain interfaces).

## Hono middleware

Drop-in protection for [Hono](https://hono.dev) routes via the
`@atlasent/sdk/hono` subpath export (requires `hono` as a peer dep):

```ts
import { Hono } from "hono";
import { atlaSentGuard, atlaSentErrorHandler } from "@atlasent/sdk/hono";

const app = new Hono();
app.onError(atlaSentErrorHandler());

app.post(
  "/deploy/:service",
  atlaSentGuard({
    action: (c) => `deploy_${c.req.param("service")}`,
    agent: (c) => c.req.header("x-agent-id") ?? "anonymous",
    context: async (c) => ({ commit: (await c.req.json()).commit }),
  }),
  (c) => c.json({ ok: true, permit: c.get("atlasent") }),
);
```

`atlaSentGuard` calls `protect()` under the hood — fail-closed
semantics. On allow it stashes a `Permit` on the context (key:
`"atlasent"`, override via `options.key`). On deny or transport error
it throws; `atlaSentErrorHandler` maps those to 403 / 503 responses
so every guarded route shares one error-handling path.

> **Upcoming migration:** after `@atlasent/enforce` reaches GA the
> guard API will change to accept a pre-constructed `Enforce` instance
> instead of per-route `action/agent/context` options. The current API
> is **not deprecated** until that ships. See the
> [CHANGELOG](./CHANGELOG.md) for the full before/after and
> [`contract/ENFORCE_PACK.md`](../contract/ENFORCE_PACK.md) for
> migration details.

## Browser support

The SDK is universal and works in modern browsers with no build-time changes:

```ts
import { AtlaSentClient } from "@atlasent/sdk";

const client = new AtlaSentClient({
  apiKey: import.meta.env.VITE_ATLASENT_API_KEY,
  baseUrl: import.meta.env.VITE_ATLASENT_API_URL,
});

const result = await client.evaluate({
  agent: currentUser.id,
  action: "view_sensitive_report",
});
```

**Auth model in browser contexts.** Shipping a long-lived API key in a browser
bundle exposes it in DevTools and makes it replayable if exfiltrated. The
recommended options in increasing security order are:

- **Option B — browser-scoped keys (short term):** Create a read-only,
  scope-restricted, IP-allowlisted key class from the AtlaSent console.
  Safe for internal dashboards where you control the network. Not suitable
  for public-facing apps.
- **Option A — session-token mode (recommended for atlasent-hosted surfaces):**
  After SSO sign-in, the frontend obtains a short-lived (15-min) Bearer token
  from `GET /v1-session/token` bound to the user's scopes and tenant. The SDK
  handles token refresh transparently. See
  [atlasent-api#144](https://github.com/AtlaSent-Systems-Inc/atlasent-api/issues/144).

The `User-Agent` header is set to `@atlasent/sdk/<version> browser` in browser
runtimes (browsers strip this header anyway — it's harmless) and
`@atlasent/sdk/<version> node/<node-version>` in Node.

## Related

- **Python SDK:** same repo, [`../python/`](../python/README.md). Wire-compatible.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
