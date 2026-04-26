# `@atlasent/sdk-v2-preview` — examples

Runnable end-to-end demonstrations of the Pillar 9 surface that
ships in this branch's ancestry (`#62` canonicalize/hash + `#64`
replay + `#67` fixtures + `#93` cross-language parity + `#97`
proof generator).

| File | Capability | Branch lineage |
|---|---|---|
| `01_canonicalize_and_hash.ts` | Pillar 9 primitives | #62 |
| `02_generate_and_verify_proof.ts` | Pillar 9 round-trip — generate then offline-replay | #62 + #64 + #97 |

Run any example:

```bash
cd typescript/packages/v2-preview
npx tsx examples/01_canonicalize_and_hash.ts
```

`tsx` is in `devDependencies`. Production callers don't need it —
these examples ship as illustrations, not as an installable
runtime.

## Examples NOT in this PR

The following are written but live on sibling branches because
their imports require other parallel preview PRs to land first.
They'll integrate naturally once the v2-preview stack merges to a
single branch (or `main` post-v2-GA):

| Capability | Sibling PR providing the import |
|---|---|
| `evaluateBatchPolyfilled` walkthrough | #94 (TS batch polyfill) |
| `parseDecisionEventStream` SSE walkthrough | #70 (TS SSE parser) |
| `GraphQLClient` query walkthrough | #84 (TS GraphQL client) |
| `withOtel` + `withSentry` stacking | #86 (OTel) + #91 (Sentry) |
| Temporal Activity wrapping | #79 (Temporal activity) |

Once any of those merges back into this branch's lineage, drop
the corresponding example here.

## Why examples?

1. **Customers see real, runnable code** before reaching for the
   SDK reference. Reading `01_canonicalize_and_hash.ts` is faster
   than parsing the JSDoc on `canonicalizePayload`.
2. **Pre-GA reviewers can sanity-check the API surface** by running
   each example and confirming it does what the docstring claims.
3. **Future regression catchers.** Wiring these into CI as `tsx`
   smoke tests catches API-shape changes that pass typecheck but
   break common patterns.

## What's NOT in here

- Examples that need a live AtlaSent server (real `evaluate` /
  `verifyPermit` calls). Those go in `atlasent-examples` once v2
  staging is up.
- The Pillar 9 callback flow against the v2 `consume` endpoint.
  That waits on v2 server.
- Temporal worker examples — those need a running Temporal cluster.
  See the `@atlasent/temporal-preview` package's README for the
  worker setup recipe.
