# AtlaSent SDKs

**Execution-time authorization for AI agents.** One call before a sensitive
action runs. Fail-closed by design — no action proceeds without an explicit,
verified permit.

| Language   | Package           | Install                    | Source                                   |
|------------|-------------------|----------------------------|------------------------------------------|
| TypeScript | `@atlasent/sdk`   | `npm i @atlasent/sdk`      | [`./typescript/`](./typescript/)         |
| Python     | `atlasent`        | `pip install atlasent`     | [`./python/`](./python/)                 |

## One line to protect an action

### TypeScript

```ts
import atlasent from "@atlasent/sdk";

const permit = await atlasent.protect({
  agent: "deploy-bot",
  action: "deploy_to_production",
  context: { commit, approver },
});
// If we got here, AtlaSent authorized it end-to-end.
// Otherwise protect() threw and the action never ran.
```

`atlasent.protect()` is the category primitive: it calls `evaluate`, then
`verifyPermit`, and either returns a verified `Permit` or throws.
There is no `{ permitted: false }` branch to forget.

### Python

```python
from atlasent import authorize

result = authorize(
    agent="clinical-data-agent",
    action="modify_patient_record",
    context={"user": "dr_smith", "environment": "production"},
)
if result.permitted:
    ...  # execute action
```

Python's category primitive is landing as `atlasent.protect()` in a
forthcoming minor bump; today's `authorize()` is wire-compatible and
shares the same fail-closed contract.

## Drop-in framework protection

### TypeScript + Hono

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
  (c) => c.json({ ok: true }),
);
```

One middleware per route, one error handler per app. AtlaSent failures
become HTTP 403 (policy denial) or 503 (transport) automatically.
See [`typescript/README.md`](./typescript/README.md) for more.

### Python + FastAPI / Flask

`atlasent_guard` / `async_atlasent_guard` decorators wrap any view.
See [`python/README.md`](./python/README.md) for the full integration.

## The wire contract

Both SDKs target the same two endpoints:

- `POST https://api.atlasent.io/v1-evaluate`
- `POST https://api.atlasent.io/v1-verify-permit`

Wire-format parity is enforced: a permit issued by the Python SDK
verifies from TypeScript and vice versa. Canonical schemas,
test vectors, and the CI drift detector live in
[`contract/`](./contract/).

## Repository layout

```
atlasent-sdk/
├── typescript/     # TypeScript SDK — npm i @atlasent/sdk
├── python/         # Python SDK — pip install atlasent
├── contract/       # Shared API contract — schemas, vectors, drift detector
└── .github/
    └── workflows/  # per-language CI, path-filtered
```

## Get an API key

Sign up at [atlasent.io](https://atlasent.io) → Settings → API Keys.

## License

- TypeScript SDK: [Apache-2.0](./typescript/LICENSE)
- Python SDK: [MIT](./python/LICENSE)
