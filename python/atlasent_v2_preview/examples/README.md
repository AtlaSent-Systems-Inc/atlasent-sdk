# `atlasent-v2-preview` — examples

Runnable end-to-end demonstrations of the Pillar 9 surface that
ships in this branch's ancestry (`#63` canonicalize/hash/models +
`#65` replay + `#68` fixtures consumer).

| File | Capability | Branch lineage |
|---|---|---|
| `01_canonicalize_and_hash.py` | Pillar 9 primitives | #63 |
| `02_verify_shared_fixtures.py` | Pillar 9 fixture-bundle replay | #63 + #65 + #68 |

Run any example:

```bash
cd python/atlasent_v2_preview
pip install -e '.[dev]'
python examples/01_canonicalize_and_hash.py
```

## Examples NOT in this PR

The following are written but live on sibling branches because
their imports require other parallel preview PRs to land first.
They'll integrate naturally once the v2-preview stack converges
or post-v2-GA:

| Capability | Sibling PR providing the import |
|---|---|
| `evaluate_batch_polyfilled` walkthrough | #95 (Python batch polyfill) |
| `parse_decision_event_stream` SSE walkthrough | #71 (Python SSE parser) |
| `GraphQLClient` query walkthrough | #85 (Python GraphQL client) |
| `with_otel` + `with_sentry` stacking | #87 + #92 (observability adapters) |
| `@atlasent_activity` Temporal wrapping | #80 (Python Temporal activity) |

Once any of those merges back into this branch's lineage, drop the
corresponding example here.

## What's NOT in here

- Examples that need a live AtlaSent server (real `evaluate` /
  `verify` calls). Those go in `atlasent-examples` once v2 staging
  is up.
- The Pillar 9 callback flow against the v2 `consume` endpoint.
  That waits on v2 server.
- Temporal worker examples — those need a running Temporal cluster.
