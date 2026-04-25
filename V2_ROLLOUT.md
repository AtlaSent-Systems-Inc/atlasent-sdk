# atlasent-sdk — v2 Rollout Plan

Wave B of the org-wide v2 rollout. See umbrella plan:
`atlasent-systems-inc/atlasent` → `V2_ROLLOUT.md`.

## Position

Bump TypeScript, Python, and Go SDKs to **2.x**. The 2.x line adds three
capabilities on top of the existing 1.x clients: batch evaluate, streaming
evaluate, and a GraphQL query client. v1.x methods remain on the client and
do not change shape.

## Scope

### TypeScript (`@atlasent/sdk`) → 2.0.0

```ts
// new
client.evaluateMany(requests: EvaluateRequest[]): Promise<PermitDecision[]>
client.authorizeStream(req: EvaluateRequest, opts?: StreamOpts): AsyncIterable<StreamEvent>

// new sub-export: GraphQL client
import { GraphQLClient } from "@atlasent/sdk/graphql";
const gql = new GraphQLClient({ apiKey, baseUrl });
await gql.policies({ filter: { active: true } });
```

- Source files (planned): `src/evaluateMany.ts`, `src/authorizeStream.ts`,
  `src/graphql/{client,queries}.ts`.
- Pull `@atlasent/types` 2.x for new shapes.
- Streaming uses Web Streams + `EventSource` polyfill in Node.

### Python (`atlasent`) → 2.0.0

```py
# new
client.authorize_many(requests: list[EvaluateRequest]) -> list[PermitDecision]
async for event in async_client.authorize_stream(req):
    ...
# new module
from atlasent.graphql import GraphQLClient
```

- Source files (planned): `atlasent/authorize_many.py`,
  `atlasent/authorize_stream.py`, `atlasent/graphql/`.
- Streaming uses `httpx` SSE support; `@atlasent_guard` learns a
  `stream=True` mode that yields events.

### Go (`github.com/AtlaSent-Systems-Inc/atlasent-sdk/go`) → v2

- New methods `EvaluateMany`, `EvaluateStream` (returns `<-chan StreamEvent`).
- Tag is `go/v2.0.0`. Module path stays `…/go` (no path bump unless required
  by `go mod`).

### `@atlasent/verify` and `@atlasent/cli`

- Unchanged in this wave; they continue to ship from 1.x lines.

## Sequencing

| Step | Description | Depends on |
|---|---|---|
| B.1 | Cut `@atlasent/types` 2.0.0 tag (driven from `atlasent-api`) | atlasent-api A.5 |
| B.2 | TS: `evaluateMany`, `authorizeStream` impls + tests          | B.1 |
| B.3 | TS: GraphQL sub-export                                       | B.1 |
| B.4 | Py: `authorize_many`, `authorize_stream` + tests             | B.1 |
| B.5 | Py: `atlasent.graphql`                                       | B.1 |
| B.6 | Go: `EvaluateMany`, `EvaluateStream` + tag `go/v2.0.0`       | B.1 |
| B.7 | Examples in `atlasent-examples/v2/*` updated to 2.x SDKs     | B.2..B.6 |

## Versioning policy

- 1.x continues on a maintenance line for at least two minors after 2.0
  publishes.
- Deprecation warnings on 1.x methods: none. 1.x stays clean.
- 2.x breaking semantics live only in *new* methods.

## Cross-repo dependencies

- **`atlasent-api`**: Wave A endpoints must land before SDK methods are real.
- **`atlasent-examples`**: `v2/{python,typescript,go}/*` already shows the
  intended API shape; SDK should match.
- **`atlasent-console`**, **`gxp-starter`**, **downstream apps**: bump their
  pin to 2.x once published.

## Open questions

- Single package `@atlasent/sdk` 2.x vs side-by-side `@atlasent/sdk-v2`?
  (Default in this plan: in-place 2.x.)
- GraphQL client: hand-written (current plan) or generate from SDL?
- Streaming back-pressure: drop or buffer?
