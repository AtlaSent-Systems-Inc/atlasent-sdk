# `@atlasent/behavior-emit`

Type-safe, HMAC-SHA256-signed event emitter for AtlaSent consumer apps
(hiCoach, Echobloom, CalmState, LedgersMe, FutureBloomPlanner) publishing
into the Behavior Verification System (BVS) ingest pipeline
(`behavior-insights`). Pairs with `@atlasent/behavior`, which reads the
aggregates computed from these events.

Every event is checked client-side against a raw-text-field blocklist
(`text`, `note`, `body`, `transcript`, `reasoning`, etc.) before it is
signed and sent — a match throws `RawTextLeakError` instead of emitting.
Raw user text must never leave the consumer app.

## Install

```bash
npm install @atlasent/behavior-emit
```

## Usage

```ts
import { createBehaviorEmitter } from '@atlasent/behavior-emit';

const emitter = createBehaviorEmitter({
  endpoint: 'https://behavior-insights.example.com',
  hmacSecret: process.env.BVS_HMAC_SECRET!,
  serviceToken: process.env.BVS_SERVICE_TOKEN, // optional
});

await emitter.emit('CalmState', {
  kind: 'episode',
  subject_id: userId,
  episode_id: episodeId,
  captured_at: new Date().toISOString(),
  context_factors: [{ factor: 'time_pressure', intensity: 'high' }],
  energy_level: 'low',
  emotional_tone: 'anxious',
});
```

`emit()` POSTs to `${endpoint}/api/internal/${source}/events` with:

| Header | Value |
|---|---|
| `X-Signature` | `sha256=` + `HMAC-SHA256(hmacSecret, "${timestamp}.${nonce}.${body}")` (hex) |
| `X-Timestamp` | Unix timestamp (seconds) |
| `X-Nonce` | Random 16-byte hex nonce |
| `Authorization` | `Bearer ${serviceToken}` (only when `serviceToken` is set) |

A non-2xx response throws `BvsEmitError` (`status`, `responseBody`). On
success, `emit()` resolves `{ ok: true, status }`.

## Event kinds

`BvsEvent` is a discriminated union on `kind`: `"episode"` (`BvsEpisodeEvent`),
`"practice"` (`BvsPracticeEvent`), `"intention"` (`BvsIntentionEvent`), and
`"reflection"` (`BvsReflectionEvent`). Intention and reflection events carry
only `has_intention` / `has_reflection` booleans — never the actual text.
`BvsContextFactor` pairs a `BvsFactorKey` (e.g. `"time_pressure"`,
`"social_risk"`, `"fatigue"`) with a `BvsFactorIntensity` (`"low"` |
`"medium"` | `"high"`). All types are exported from `@atlasent/behavior-emit`.

## API

| Export | Description |
|---|---|
| `createBehaviorEmitter(opts: BehaviorEmitOptions): BehaviorEmitter` | Builds an emitter bound to one endpoint + HMAC secret |
| `BehaviorEmitter.emit(source, event)` | Signs and POSTs one `BvsEvent`; resolves `EmitResult` |
| `assertNoRawText(value, path?)` | Throws `RawTextLeakError` if a raw-text field is present |
| `BvsEmitError` | Thrown on a non-2xx ingest response |

`BehaviorEmitOptions`: `{ endpoint, hmacSecret, serviceToken?, timeoutMs? }`
(`timeoutMs` default `10000`).

## Local development

```bash
cd typescript/packages/behavior-emit
npm install
npm test
npm run typecheck
npm run build
```

## License

Apache-2.0 — see [`LICENSE`](./LICENSE).
