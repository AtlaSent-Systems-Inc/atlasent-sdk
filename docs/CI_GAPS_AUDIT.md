# CI gaps audit — 2026-04-29

Inventory of sub-packages whose tests don't run on every PR. Result
of the workflow sweep that surfaced the missing `go-ci.yml` (fixed
on PR #125) and the missing v2-alpha CI (fixed on this PR).

## Mechanism

`python-ci.yml` and `typescript-ci.yml` test only the **root**
v1 packages — `python/atlasent/` and `typescript/src/`. The path
filters on those workflows match every directory under `python/**`
/ `typescript/**`, so they trigger on every relevant PR, but the
`pytest tests/` / `npm run test:coverage` invocation reads from the
root pyproject / package.json only.

Sub-packages live in their own directory with their own
pyproject.toml / package.json + tests. They are silently skipped
unless they have a dedicated workflow.

## Status

| Sub-package | Path | PR-time CI | Status |
|---|---|---|---|
| atlasent-v2-alpha | `python/atlasent_v2_alpha/` | ✅ added on this PR | `v2-alpha-ci.yml` |
| @atlasent/sdk-v2-alpha | `typescript/packages/v2-alpha/` | ✅ added on this PR | `v2-alpha-ci.yml` |
| atlasent-enforce | `python/atlasent_enforce/` | ✅ existing | `enforce-ci.yml` |
| @atlasent/enforce | `typescript/packages/enforce/` | ✅ existing | `enforce-ci.yml` |
| go SDK | `go/` | ✅ added on PR #125 | `go-ci.yml` |
| @atlasent/temporal | `typescript/packages/temporal/` | ❌ missing | follow-up |
| @atlasent/otel | `typescript/packages/otel/` | ❌ missing | follow-up |
| @atlasent/sentry | `typescript/packages/sentry/` | ❌ missing | follow-up |
| @atlasent/verify | `typescript/packages/verify/` | ❌ missing | follow-up |
| atlasent-temporal-preview | `python/atlasent_temporal_preview/` | ❌ missing | follow-up |
| atlasent-otel-preview | `python/atlasent_otel_preview/` | ❌ missing | follow-up |
| atlasent-sentry-preview | `python/atlasent_sentry_preview/` | ❌ missing | follow-up |

## Why this PR doesn't fix all of them

The four adapter / verify sub-packages (`temporal`, `otel`, `sentry`,
`verify`) are a separate concern and would each ship as their own
workflow. Bundling them all into a single PR would dilute the
v2-alpha fix; they get their own follow-up. The audit table above
makes the gap visible so it doesn't slip.

## Recommended follow-up structure

One workflow per package family, gated on its own paths so v1 PRs
don't fan out unrelated CI:

- `temporal-ci.yml` — covers `typescript/packages/temporal/` +
  `python/atlasent_temporal_preview/`
- `otel-ci.yml` — covers `typescript/packages/otel/` +
  `python/atlasent_otel_preview/`
- `sentry-ci.yml` — covers `typescript/packages/sentry/` +
  `python/atlasent_sentry_preview/`
- `verify-ci.yml` — covers `typescript/packages/verify/` (TS-only)

Each mirrors the structure of `v2-alpha-ci.yml` (matrix on TS 20.x +
22.x and Python 3.10/3.11/3.12, `npm test` + `pytest`).
