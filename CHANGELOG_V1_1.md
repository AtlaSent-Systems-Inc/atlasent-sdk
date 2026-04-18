# @atlasent/sdk v1.1 Changelog

## v1.1 (Incremental — non-breaking)

> v1.1 extends the v1 architecture without replacing it.
> All v1.0 usage remains compatible.

### New Features

#### `AsyncClient` — parallel evaluate calls

```typescript
import { AsyncClient } from '@atlasent/sdk';

const client = new AsyncClient({
  apiUrl: 'https://api.atlasent.io',
  apiKey: 'atk_live_...',
});

// Evaluate multiple actions concurrently
const [deployResult, exportResult] = await Promise.all([
  client.evaluate({ action: { id: 'deployment.production' }, actor }),
  client.evaluate({ action: { id: 'data.export' }, actor }),
]);
```

#### `authorize_many` — batch evaluation

```typescript
const results = await client.authorizeMany([
  { action: { id: 'deployment.production' }, actor },
  { action: { id: 'data.export' }, actor },
  { action: { id: 'config.update' }, actor },
]);

// results: EvaluationResult[]
// Order matches input order; partial failures surface per-item
```

#### Testing Module — `AtlaSentMock`

```typescript
import { AtlaSentMock } from '@atlasent/sdk/testing';

const mock = new AtlaSentMock();
mock.allowAll(); // or mock.denyAll() or mock.setDecision('deployment.production', 'deny')

// Use as a drop-in for AtlaSentClient in tests
const result = await mock.evaluate({ action: { id: 'deployment.production' }, actor });
```

#### OpenTelemetry Tracing

```typescript
import { AtlaSentClient } from '@atlasent/sdk';
import { trace } from '@opentelemetry/api';

const client = new AtlaSentClient({
  apiUrl: 'https://api.atlasent.io',
  apiKey: 'atk_live_...',
  tracing: {
    tracer: trace.getTracer('atlasent'),
    // Adds spans: atlasent.evaluate, atlasent.permit.verify
  },
});
```

#### Type Alignment with `@atlasent/types`

All SDK types are now re-exported from `@atlasent/types` v2.0.0.
Existing imports continue to work via re-export aliases.

```typescript
// v1.0 import (still works)
import type { Decision } from '@atlasent/sdk';

// v1.1 preferred (same type)
import type { Decision } from '@atlasent/types';
```

#### Local Evaluator — Offline Fallback Only

The local evaluator is **demoted** to a read-only offline fallback:
- Remote `allow` → trusted
- Remote `deny` → always wins (local fallback cannot override)
- Used only when `ATLASENT_OFFLINE=true` or network is unreachable

This is **not breaking** — default behavior is unchanged unless you were
relying on local-only evaluation to override remote denials.

### No Breaking Changes

- All v1.0 `AtlaSentClient` options remain valid
- All v1.0 method signatures unchanged
- `Decision`, `Permit`, `RiskAssessment` type shapes unchanged
