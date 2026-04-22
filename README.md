# AtlaSent SDKs

Execution-time authorization for AI agents and services. Fail-closed by
design -- no action proceeds without a server-issued, server-verified permit.

| Language   | Package         | Install                  | Source                                                                              |
|------------|-----------------|--------------------------|-------------------------------------------------------------------------------------|
| Python     | `atlasent`      | `pip install atlasent`   | [`./python/`](./python/)                                                            |
| TypeScript | `@atlasent/sdk` | `npm i @atlasent/sdk`    | [`atlasent/packages/sdk/`](https://github.com/AtlaSent-Systems-Inc/atlasent/tree/main/packages/sdk) |

The canonical TypeScript SDK is maintained in the [`atlasent`
monorepo](https://github.com/AtlaSent-Systems-Inc/atlasent) alongside
`@atlasent/types`. This repo now hosts only the Python SDK and the shared
[`contract/`](./contract/) (schemas, vectors, drift detector) that both SDKs
conform to.

## 30-second quickstart

### Python

```python
from atlasent import AtlaSentClient, EvaluateRequest

with AtlaSentClient(api_key="ak_...") as client:
    # Evaluate + verify + run, fail-closed end-to-end.
    client.with_permit(
        EvaluateRequest(
            action_type="modify_patient_record",
            actor_id="clinical-data-agent",
            context={"user": "dr_smith", "environment": "production"},
        ),
        lambda evaluation, verification: do_the_thing(),
    )
```

### TypeScript

```ts
import { createClient } from "@atlasent/sdk";

const client = createClient({ apiKey: process.env.ATLASENT_API_KEY! });

await client.withPermit(
  {
    action_type: "modify_patient_record",
    actor_id: "clinical-data-agent",
    context: { user: "dr_smith", environment: "production" },
  },
  async ({ evaluation, verification }) => {
    // Only reachable on allow + consumed permit.
    await doTheThing();
  },
);
```

## API endpoints

Both SDKs target the same two endpoints:

- `POST https://api.atlasent.io/v1-evaluate`
- `POST https://api.atlasent.io/v1-verify-permit`

Authorization is carried in `Authorization: Bearer <api_key>`; the API key is
never sent in the request body. A Python permit_token is verifiable from the
TypeScript SDK and vice-versa.

## Repository layout

```
atlasent-sdk/
├── python/         # Python SDK -- pip install atlasent
├── contract/       # Shared API contract -- schemas, vectors, drift detector
└── .github/
    └── workflows/  # python + contract CI, path-filtered
```

## The contract

Canonical request / response shapes live in
[`contract/schemas/`](./contract/schemas/). Round-trip vectors in
[`contract/vectors/`](./contract/vectors/) are shared across both SDKs; drift
is enforced in CI by [`contract/tools/drift.py`](./contract/tools/drift.py),
which introspects the Python SDK's pydantic models and (when the sibling
monorepo is checked out) the TypeScript SDK's `@atlasent/types` interfaces.

## Getting an API key

Sign up at [atlasent.io](https://atlasent.io) → Settings → API Keys.

## License

- Python SDK: [MIT](./python/LICENSE)
- Contract: [MIT](./LICENSE)
