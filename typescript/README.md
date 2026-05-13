# @atlasent/sdk

Execution-time authorization for AI agents, in TypeScript. Fail-closed by design, zero runtime dependencies.

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

`evaluate()` calls the AtlaSent policy engine, generates a hash-chained audit entry (21 CFR Part 11 / GxP-ready), and returns a result you branch on. A clean `DENY` is **not** thrown — network, auth, and server failures are.

## 0.1.0 surface

```ts
// Policy decision
client.evaluate({ agent, action, context? })
  // → { decision: "ALLOW" | "DENY", permitId, reason, auditHash, timestamp }

// Permit verification (end-to-end second-factor gate)
client.verifyPermit({ permitId, agent?, action?, context? })
  // → { verified, outcome, permitHash, timestamp }

// Streaming evaluation (async generator, SSE)
client.evaluateStream({ agent, action, context? })
  // → AsyncGenerator<EvaluateStreamEvent>

// Offline audit bundle verification (no network call)
import { verifyBundle } from "@atlasent/sdk";
await verifyBundle("/path/to/export.bundle.json")
  // → { valid, eventCount, publicKey, error }
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
```

See [`examples/deploy-gate.ts`](./examples/deploy-gate.ts) for a complete CI-shaped script.

## Streaming evaluation

Stream partial reasoning and the final decision as they arrive from the policy engine:

```ts
for await (const event of client.evaluateStream({ agent, action })) {
  if (event.type === "reasoning") {
    console.log("Policy engine:", event.content);
  } else if (event.type === "policy_check") {
    console.log(`  ${event.policyId}: ${event.outcome}`);
  } else if (event.type === "decision") {
    if (event.permitted) {
      console.log("Permitted — permitId:", event.permitId);
    } else {
      console.warn("Denied:", event.reason);
    }
  }
}
```

Events arrive in order: zero or more `"reasoning"` events, zero or more `"policy_check"` events, then exactly one `"decision"` event. A `DENY` is yielded — not thrown.

## Offline audit verification

Validate an Ed25519-signed audit export bundle without any network call:

```ts
import { verifyBundle } from "@atlasent/sdk";

const result = await verifyBundle("/path/to/export.bundle.json");
if (result.valid) {
  console.log(`Bundle intact — ${result.eventCount} events verified`);
} else {
  throw new Error(`Audit bundle tampered: ${result.error}`);
}
```

Requires Node.js 20+ (uses `node:crypto` and `node:fs/promises` — no additional npm dependencies).

## Error handling

The SDK throws exactly one error type — `AtlaSentError` — with a flat shape:

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
| `network`          | DNS / connection failure                                |
| `bad_response`     | non-JSON body or missing required fields                |

Every `AtlaSentError` carries `err.requestId` — the UUID sent as `X-Request-ID`, correlatable in server logs.

## Constructor options

```ts
new AtlaSentClient({
  apiKey: "ask_live_...",              // required
  baseUrl: "https://api.atlasent.io", // default
  timeoutMs: 10_000,                  // default — per-request
  fetch: customFetch,                 // default: globalThis.fetch
});
```

## Design choices

- **Fail-closed.** A clean `DENY` is returned so your code explicitly handles it; every other failure throws, so no action proceeds silently.
- **Native `fetch` only.** No axios, no polyfills. Node 20+ has everything needed.
- **Zero runtime dependencies.** Strongly typed via plain TS interfaces.
- **Bearer-token auth.** `Authorization: Bearer <apiKey>` so request-body logs never capture the key.

## API endpoints (0.1.0 surface)

| Method           | Endpoint                    |
|------------------|-----------------------------|
| `evaluate`       | `POST /v1-evaluate`         |
| `verifyPermit`   | `POST /v1-verify-permit`    |
| `evaluateStream` | `POST /v1-evaluate-stream`  |
| `verifyBundle`   | *(offline — no API call)*   |

## Not included in 0.1.0

The following endpoints are deferred to a later release:

- `POST /v1-session` — session management
- `GET/POST /v1-audit/events` — audit event queries
- `GET /v1-audit/exports` — audit export downloads
- `POST /v1-audit/verify` — server-side bundle verification
- `POST /v1-approvals` — human-in-the-loop approvals
- `POST /v1-overrides` — policy overrides
- `POST /v1-permits/consume` — permit consumption
- `POST /v1-permits/revoke` — permit revocation

Also deferred: importing types from `@atlasent/types` (types are currently defined locally in `src/types.ts`).

## Requirements

- Node.js **20** or newer (`fetch`, `AbortSignal.timeout`, `crypto.randomUUID`, `crypto.subtle` Ed25519)
- TypeScript **5.0+** for best type-inference ergonomics

## Related

- **Python SDK:** same repo, [`../python/`](../python/README.md). Wire-compatible — a Python-signed audit bundle verifies cleanly in TypeScript and vice versa.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
