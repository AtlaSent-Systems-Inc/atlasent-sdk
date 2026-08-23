# `@atlasent/behavior`

AtlaSent Behavior Verification System (BVS) integration — read privacy-bounded
behavioral aggregates from the `behavior-insights` service and enrich AtlaSent
`evaluate` calls with a `bvsSnapshot` context field for v2 `riskScore`
computation.

This package never sees raw event text. Every response is checked
client-side against a raw-text-field blocklist (`text`, `note`, `body`,
`transcript`, etc.) as defense-in-depth on top of the server-side privacy
enforcement in `behavior-insights` — a match throws `RawTextLeakError`
instead of returning the value.

## Install

```bash
npm install @atlasent/behavior
```

Peer dependency: `@atlasent/sdk` `^2.0.0`.

## Usage

```ts
import { getStateSummary, getCategoryAggregate, attachToEvaluate } from '@atlasent/behavior';

const clientOpts = {
  baseUrl: 'https://behavior-insights.example.com',
  apiKey: process.env.BEHAVIOR_INSIGHTS_API_KEY!,
};

// Aggregate event counts over a rolling window (default 30 days)
const summary = await getStateSummary(userId, clientOpts, { windowDays: 14 });
// -> { user_id, window_start, window_end, event_count, category_counts } | null

// Count for a single behavior category
const aggregate = await getCategoryAggregate(
  userId,
  'behavior.health.adherence',
  clientOpts,
);
// -> { user_id, category, count, window_days, confidence_low }
```

### Enriching an `evaluate` call

`attachToEvaluate` fetches the frozen `BvsSnapshot` wire shape and returns an
object to spread into `EvaluateRequest.context`. It fails open (`{}`) when the
snapshot is unavailable — a down or empty behavior-insights service must never
block an unrelated `evaluate` call.

```ts
import { AtlaSentClient } from '@atlasent/sdk';
import { attachToEvaluate } from '@atlasent/behavior';

const atlasent = new AtlaSentClient({ apiKey, baseUrl });

const context = {
  ...baseContext,
  ...(await attachToEvaluate(userId, clientOpts)),
};

const decision = await atlasent.evaluate({ action_type: actionType, actor_id: actorId, context });
```

## API

| Export | Signature | Description |
|---|---|---|
| `getStateSummary` | `(userId, clientOpts, opts?) => Promise<StateSummary \| null>` | Rolling-window event counts by category |
| `getCategoryAggregate` | `(userId, category, clientOpts, opts?) => Promise<CategoryAggregate>` | Count for a single `BehaviorCategory` |
| `getBvsSnapshot` | `(userId, clientOpts) => Promise<BvsSnapshot \| null>` | Raw `BvsSnapshot` (factors, confidence, computed_at) |
| `attachToEvaluate` | `(userId, clientOpts) => Promise<Record<string, unknown>>` | `{ bvsSnapshot }` or `{}` — spread into `evaluate` context |
| `assertNoRawText` | `(data, path?) => void` | Throws `RawTextLeakError` if a raw-text field is present |

`BehaviorClientOptions`: `{ baseUrl, apiKey, timeoutMs? }` (`timeoutMs` default `10000`).

All aggregate shapes (`StateSummary`, `CategoryAggregate`, `BvsSnapshot`,
`ConsentClassProjection`, `BehaviorCategory`) are exported as types from
`@atlasent/behavior`.

## Local development

```bash
cd typescript/packages/behavior
npm install
npm run typecheck
npm run build
```

## License

Apache-2.0 — see [`LICENSE`](./LICENSE).
