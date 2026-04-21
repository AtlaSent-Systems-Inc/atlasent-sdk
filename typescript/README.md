# @atlasent/sdk

Execution-time authorization for AI agents, in TypeScript. Zero runtime dependencies, one function call per decision — or wrap a route handler in a single line with the Express / Fastify guards.

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

## The surface

Two canonical endpoints, plus two convenience compositions:

```ts
client.evaluate({ agent, action, context? })
  // → { decision: "ALLOW" | "DENY", permitId, reason, auditHash, timestamp }

client.verifyPermit({ permitId, agent?, action?, context? })
  // → { verified, outcome, permitHash, timestamp }

client.gate({ agent, action, context? })
  // → { evaluation, verification }  — throws PermissionDeniedError on deny

client.authorize({ agent, action, context?, verify?, raiseOnDeny? })
  // → { permitted, permitId, permitHash, auditHash, verified, reason, ... }
```

`verifyPermit()` confirms a previously-issued permit end-to-end. `gate()` is the throw-on-deny shortcut for route handlers. `authorize()` is the result-based one-call API for code that prefers branching over catching.

## One-call authorization

```ts
const result = await client.authorize({
  agent: "clinical-data-agent",
  action: "modify_patient_record",
  context: { user: "dr_smith" },
});

if (!result.permitted) {
  console.warn("Denied:", result.reason);
  return;
}
// result.permitHash is populated — a verified permit is in hand.
```

Pass `raiseOnDeny: true` for exception-style flow, or `verify: false` to skip the second round-trip.

## Decision cache

`TTLCache` deduplicates `evaluate()` calls for the same `(agent, action, context)` within a short window. Only `ALLOW` results are cached — a `DENY` is never cached, so policy changes take effect immediately:

```ts
import { AtlaSentClient, TTLCache } from "@atlasent/sdk";

const client = new AtlaSentClient({
  apiKey: process.env.ATLASENT_API_KEY!,
  cache: new TTLCache({ ttlMs: 30_000 }),
});
```

The cache key derivation is byte-compatible with the Python SDK, so a single cache entry is addressable across languages (useful if you proxy from one to the other).

## Express / Fastify guards

```ts
import { AtlaSentClient, expressGuard } from "@atlasent/sdk";

const client = new AtlaSentClient({ apiKey: process.env.ATLASENT_API_KEY! });

app.post(
  "/modify-record",
  expressGuard(client, {
    action: "modify_patient_record",
    agent: (req) => req.user.id,
    context: (req) => ({ patientId: req.params.patientId }),
  }),
  (req, res) => {
    // req.atlasent holds the verified GateResult
    res.json({ permitHash: req.atlasent!.verification.permitHash });
  },
);
```

`fastifyGuard()` is identical in shape — use it as a `preHandler`. A generic `guard()` HOF is also exported for non-framework code.

## Retries

`AtlaSentClient` retries transient failures (5xx, timeouts, network) with exponential backoff. It does **not** retry on 401/403/429/4xx (those are policy / client errors, not transients).

```ts
new AtlaSentClient({
  apiKey: "ask_live_...",
  maxRetries: 2,       // default
  retryBackoffMs: 500, // default (doubles each attempt: 500, 1000, 2000…)
});
```

## Environment-based config

```ts
import { AtlaSentClient, fromEnv } from "@atlasent/sdk";

const client = new AtlaSentClient(fromEnv());
// Reads: ATLASENT_API_KEY (required),
//        ATLASENT_BASE_URL, ATLASENT_TIMEOUT(_MS),
//        ATLASENT_MAX_RETRIES, ATLASENT_RETRY_BACKOFF
```

Or, for script-style code, call `configure()` once and use the top-level `authorize()` / `gate()` helpers:

```ts
import { configure, authorize } from "@atlasent/sdk";
configure({ apiKey: process.env.ATLASENT_API_KEY! });
const result = await authorize({ agent: "a", action: "b" });
```

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
  apiKey: "ask_live_...",             // required
  baseUrl: "https://api.atlasent.io", // default
  timeoutMs: 10_000,                  // default — per-request
  maxRetries: 2,                      // default — 5xx / timeout / network
  retryBackoffMs: 500,                // default — doubled per attempt
  cache: new TTLCache(),              // optional — dedupe repeated ALLOWs
  logger: consoleLogger,              // optional — noopLogger by default
  fetch: customFetch,                 // default: globalThis.fetch
});
```

## Structured logging

Pass any `{ debug, info, warn, error }` object as `logger`. The client emits structured fields at key points (retry, cache hit, DENY, permit issued) — drop in `consoleLogger` for local debugging, or wire your own pino / winston / Datadog adapter:

```ts
import { AtlaSentClient, consoleLogger } from "@atlasent/sdk";
const client = new AtlaSentClient({ apiKey, logger: consoleLogger });
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
- TypeScript **5.0+** for best type-inference ergonomics (older is fine — types are plain interfaces).

## Related

- **Python SDK:** same repo, [`../python/`](../python/README.md). Wire-compatible.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
