# AtlaSent SDKs

Execution-time authorization for AI agents in GxP-regulated environments.
Fail-closed by design — no action proceeds without an explicit permit.

This repository is the home of AtlaSent's official SDKs.

| Language   | Package           | Install                    | Docs                                                           | Version |
|------------|-------------------|----------------------------|----------------------------------------------------------------|---------|
| Python     | `atlasent`        | `pip install atlasent`     | [`./python/`](./python/README.md)                              | 0.3.0   |
| TypeScript | `@atlasent/sdk`   | `npm i @atlasent/sdk`      | [`./typescript/`](./typescript/README.md)                      | 0.1.0   |

## 30-second quickstart

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

### TypeScript

```ts
import { AtlaSentClient } from "@atlasent/sdk";

const client = new AtlaSentClient({ apiKey: process.env.ATLASENT_API_KEY! });

const result = await client.evaluate({
  agent: "clinical-data-agent",
  action: "modify_patient_record",
  context: { user: "dr_smith", environment: "production" },
});

if (result.decision === "ALLOW") {
  // execute action
}
```

## API endpoints

Both SDKs target the same two endpoints:

- `POST https://api.atlasent.io/v1-evaluate`
- `POST https://api.atlasent.io/v1-verify-permit`

Full wire-format parity: a Python permit token is verifiable from the
TypeScript SDK and vice-versa.

## Repository layout

```
atlasent-sdk/
├── python/         # Python SDK (full-featured: authorize(), async, cache, guard decorators)
├── typescript/     # TypeScript SDK (minimal: evaluate + verifyPermit)
├── contract/       # Shared API contract — schemas, vectors, drift detector, policy linter
└── .github/
    └── workflows/  # per-language + contract CI, path-filtered
```

## The contract

All SDKs target the same two endpoints and the same wire shapes. The
canonical definitions — JSON Schemas, test vectors, and the
machine-enforced drift detector + policy linter — live in
[`contract/`](./contract/). If you're building a new AtlaSent SDK or
verifying an existing one, start with
[`contract/README.md`](./contract/README.md) and
[`contract/SDK_COMPATIBILITY.md`](./contract/SDK_COMPATIBILITY.md).

## Contributing

Per-language setup lives in each subdirectory's README. CI runs
automatically on PRs that touch the corresponding subdir.

## Getting an API key

Sign up at [atlasent.io](https://atlasent.io) → Settings → API Keys.

## License

- Python SDK: [MIT](./python/LICENSE)
- TypeScript SDK: [Apache-2.0](./typescript/LICENSE)
