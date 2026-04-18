> [!NOTE]
> **Repo rename pending:** This repo is named `atlasent-sdk-python` but contains `python/`, `typescript/`, and `contract/` — it is a multi-language SDK monorepo. It will be renamed to `atlasent-sdk`.
>
> - **Python SDK** (`pip install atlasent`) — canonical here, in [`./python/`](./python/)
> - **TypeScript SDK** (`npm install @atlasent/sdk`) — canonical in [`atlasent-sdk-typescript`](https://github.com/AtlaSent-Systems-Inc/atlasent-sdk-typescript)
> - **`./typescript/`** — deprecated in favour of `atlasent-sdk-typescript`

# AtlaSent SDKs

Execution-time authorization for AI agents in GxP-regulated environments.
Fail-closed by design — no action proceeds without an explicit permit.

| Language   | Package           | Install                    | Canonical repo                                                                   |
|------------|-------------------|----------------------------|----------------------------------------------------------------------------------|
| Python     | `atlasent`        | `pip install atlasent`     | this repo → [`./python/`](./python/)                                             |
| TypeScript | `@atlasent/sdk`   | `npm i @atlasent/sdk`      | [`atlasent-sdk-typescript`](https://github.com/AtlaSent-Systems-Inc/atlasent-sdk-typescript) |

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
import { configure, authorize } from "@atlasent/sdk";

configure({ apiKey: process.env.ATLASENT_API_KEY! });

const result = await authorize({
  agent: "clinical-data-agent",
  action: "modify_patient_record",
  context: { user: "dr_smith", environment: "production" },
});

if (result.permitted) {
  // execute action
}
```

## API endpoints

Both SDKs target the same two endpoints:

- `POST https://api.atlasent.io/v1-evaluate`
- `POST https://api.atlasent.io/v1-verify-permit`

Full wire-format parity: a Python permit token is verifiable from the TypeScript SDK and vice-versa.

## Repository layout

```
atlasent-sdk/  (this repo — currently named atlasent-sdk-python)
├── python/         # Python SDK — pip install atlasent
├── typescript/     # DEPRECATED — use atlasent-sdk-typescript instead
├── contract/       # Shared API contract — schemas, vectors, drift detector
└── .github/
    └── workflows/  # per-language CI, path-filtered
```

## The contract

All SDKs target the same two endpoints and wire shapes. Canonical definitions live in [`contract/`](./contract/).

## Getting an API key

Sign up at [atlasent.io](https://atlasent.io) → Settings → API Keys.

## License

- Python SDK: [MIT](./python/LICENSE)
- TypeScript SDK: [Apache-2.0](./typescript/LICENSE)
