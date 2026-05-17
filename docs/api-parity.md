# SDK ↔ API Parity Matrix

**Status:** active · **Owner:** SDK + API · **Related gate:** [`atlasent/V1_GATES.md` § G4](https://github.com/AtlaSent-Systems-Inc/atlasent/blob/main/V1_GATES.md#g4--sdk-hitl-surface-ahead-of-api-handler)

Every SDK method that crosses the wire MUST have a corresponding API handler
status tracked here. If the handler is `absent`, the method MUST NOT ship.
The check script (`scripts/check-api-parity.mjs`, wired into CI by
`.github/workflows/api-parity.yml`) enforces this on every PR.

## How registration works

The check is **opt-in by annotation** — it does not try to enumerate every
export in `typescript/src/` or `python/atlasent_sdk/`. Add the annotation:

```ts
// @hitl-method <slug>
export async function requestHumanApproval(...) { ... }
```

```py
# @hitl-method <slug>
def request_human_approval(...): ...
```

The slug appears as the **row key** in the matrix below. If the script finds
an annotation whose slug is missing from the matrix, CI fails. If the matrix
lists a slug whose handler status is `absent` AND the slug has live
annotations, CI also fails. Removing an annotation (or moving the row to
`handler: absent` after deprecating the API handler) cleans up the failure.

Why registration vs full enumeration: the SDK has 40+ source files and many
exports unrelated to HITL (helpers, types, middleware, retry, etc.). A full
enumerator would flag every helper and require denylisting most of them. The
registration pattern asks the author of a new HITL method to opt in once,
which is the actual point of the gate.

## Matrix

Format: each row maps an SDK method slug to its API handler status. Statuses:

- **`ga`** — API handler is on the V1 GA surface (post 2026-05-17).
- **`alpha`** — API handler exists but is alpha-only (under V3 Pillar 1
  alpha-endpoint surface; subject to change until the post-GA tag).
- **`absent`** — No API handler. Method MUST NOT have live `@hitl-method`
  annotations until the handler ships.

### TypeScript SDK (`typescript/src/`)

<!-- registry-start -->
<!--
  Format: `| slug | source-file:fn | handler-path | status | notes |`
  Add a row whenever you add `// @hitl-method <slug>` in a new TS export.
  Remove the row (or flip status) when the API handler lands or is removed.
-->

| Slug | Source | API handler | Status | Notes |
|---|---|---|---|---|
| _none registered_ | — | — | — | Existing HITL surfaces in `hitl.ts`, `approvalArtifact.ts`, `approvalQuorum.ts`, `regulatoryEscalation.ts` are pre-V1 and not registered yet; backfill on next touch. |

<!-- registry-end -->

### Python SDK (`python/atlasent_sdk/`)

<!-- python-registry-start -->

| Slug | Source | API handler | Status | Notes |
|---|---|---|---|---|
| _none registered_ | — | — | — | Same backfill plan as TS. |

<!-- python-registry-end -->

## Backfill plan (existing HITL surface)

The SDK already exports HITL-adjacent methods that predate this matrix:

- `typescript/src/hitl.ts`
- `typescript/src/approvalArtifact.ts`
- `typescript/src/approvalQuorum.ts`
- `typescript/src/regulatoryEscalation.ts`
- `typescript/src/v2.ts` (escalation paths, behavior-aware approval flows)
- `python/atlasent_sdk/` peers of the above (where they exist)

These ship today and the gate does not block their continued use. As each
module is touched in Wave C (V2_ROLLOUT.md), the next PR against it MUST:

1. Audit each exported function for HITL semantics (crosses the wire to a
   human-in-the-loop API surface).
2. Add `// @hitl-method <slug>` (or `# @hitl-method <slug>`) above each such
   export.
3. Add the corresponding row to the matrix above with the handler status.
4. If the handler status is `absent`, either ship the API handler in the
   same coordinated PR, or do not add the annotation.

A tracking issue for the backfill goes in V1_GATES.md G4 resolution log when
this matrix lands.

## V3 escalate decision

`AtlaSentEscalateError` (V3 Pillar 2 sketch in
[`atlasent/V3_ROLLOUT.md`](https://github.com/AtlaSent-Systems-Inc/atlasent/blob/main/V3_ROLLOUT.md))
is NOT registered here. Adding it requires:

1. A V2-D11+ decision entry in
   [`atlasent/V2_DECISIONS.md`](https://github.com/AtlaSent-Systems-Inc/atlasent/blob/main/V2_DECISIONS.md)
   locking the wire surface.
2. API handler ships.
3. SDK method added with `// @hitl-method escalate.v1` annotation.
4. Matrix row added with `status: ga`.

In that order. The gate enforces the order: an SDK export annotated with
an unregistered slug fails CI before publish.

## CI integration

The workflow `.github/workflows/api-parity.yml` runs
`scripts/check-api-parity.mjs` on every push and PR. Failure modes:

- **Annotation without matrix row** — `@hitl-method <slug>` found in source
  but no row with that slug in the matrix. Fix: add the row.
- **Matrix row with `status: absent` but live annotations** — the matrix
  records the handler as missing yet the SDK ships the method. Fix: ship
  the handler first, then update status; or remove the annotation.
- **Malformed matrix table** — the script can't parse the registry block.
  Fix: keep one row per line, preserve the `<!-- registry-start -->` /
  `<!-- registry-end -->` markers.

## Out of scope for this PR

- Cross-checking matrix `handler` paths against `openaispec/openapi.yaml`
  (validating that a row claiming `status: ga` actually has an OpenAPI
  operation at that path). Tracked as G4 phase 2; would require fetching
  `openaispec` as a CI dependency.
- Auto-generating matrix rows from JSDoc. Possible follow-up once the
  initial backfill establishes a stable annotation convention.
