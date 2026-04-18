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

- TypeScript **5.0+** for best type-inference ergonomics (older is fine — types are plain interfaces).
- A runtime with the WHATWG `fetch` API.

### Runtime support matrix

| Runtime           | Status     | Notes                                               |
|-------------------|------------|-----------------------------------------------------|
| Node.js ≥ 20      | Supported  | Default Node-shaped build (`dist/index.{js,cjs}`).  |
| Bun ≥ 1.1         | Supported  | Uses the Node-shaped build; native `fetch`.         |
| Deno ≥ 1.40       | Supported  | Resolves the `deno` export → browser-shaped build.  |
| Cloudflare Workers / `workerd` | Supported | Resolves the `workerd` export.        |
| Vercel Edge / EdgeRuntime      | Supported | Browser-shaped build, no Node built-ins.    |
| Modern browsers   | See below  | Use `@atlasent/sdk/browser`; secret keys rejected.  |
| Node.js ≤ 18      | Unsupported | No native `fetch` / `AbortSignal.timeout`.         |

### Using the SDK from a browser

The SDK ships a separate **browser entry** that refuses to construct
the client when it sees a secret-style API key (`ask_live_*`,
`ask_test_*`, `sk_*`) in a window context — secret keys belong on the
server. You should normally call AtlaSent from your backend, not from
the browser.

```ts
// Only safe with non-secret keys, e.g. via a token-exchange endpoint.
import { AtlaSentClient } from "@atlasent/sdk/browser";
```

For trusted internal dashboards already gated by SSO, an explicit
opt-in (`{ allowBrowser: true }`) is provided. **Roadmap:** publishable
client-side keys with a scoped permit-exchange flow — see the AtlaSent
roadmap.

## Related

- **Python SDK:** same repo, [`../python/`](../python/README.md). Wire-compatible.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
