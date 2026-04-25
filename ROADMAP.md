# atlasent-sdk — v1 ship plan

Client SDKs: TypeScript (`@atlasent/sdk`), Python (`atlasent`), Go (`github.com/AtlaSent-Systems-Inc/atlasent-sdk/go`). Nothing ships to customers until these ship.

## GA (v1) — must ship

Status snapshot (2026-04-25):

1. **TS SDK publish** — 🚫 BLOCKED on `NPM_TOKEN` (Waqas). Code is at `typescript/package.json` v1.4.0, `publish-npm.yml` workflow exists. Tag → publish.
2. **Python SDK publish** — 🚫 BLOCKED on `PYPI_TOKEN` (Waqas). Code is at `python/_version.py` v1.4.0, `publish-pypi.yml` workflow exists. Tag → publish.
3. **Go SDK publish** — ❌ NOT DONE. No `go.mod` exists; no `go/v*` tags. Module needs scaffolding before tag.
4. **v1-only API sweep** — ✅ DONE. No `v2` references in `typescript/src/` or `python/atlasent/` source. (Roadmap docs reference "v2" planning waves; that's intentional.)
5. **Offline verifier** — ❌ NOT DONE. `verifyBundle()` is exported from the main SDK; not yet split out as `@atlasent/verify`.
6. **SSO-aware types** — ❌ NOT DONE. `SsoConnection`, `SsoJitRule`, `SsoEvent` not exported from `@atlasent/types`. The `atlasent-api/v1-sso` handler is shipped, so the wire shapes are pinnable now.

### Movable now (no external dependencies)

- Export `SsoConnection`, `SsoJitRule`, `SsoEvent` from `@atlasent/types` (sourced from `atlasent-api/packages/types/src/`) — item 6.
- Carve out `@atlasent/verify` as a thin re-export of `verifyBundle()` with no SDK runtime imports — item 5.
- Scaffold the Go SDK module: `go/go.mod`, `go/client.go`, `go/types.go` (mirror TS shapes), `go/README.md`. Keeps tag-and-publish a one-line operation when `NPM_TOKEN` arrives — item 3.

### Blocked on external

- npm + PyPI publishes (items 1, 2). All scaffolding ready; needs Waqas to set `NPM_TOKEN` (npm org access for `@atlasent`) and `PYPI_TOKEN` (PyPI project: `atlasent`).

## Post-GA — ordered by impact

7. **Retries with jitter + Sentry breadcrumbs** — the `authorize()` call should retry transient failures (429 with `Retry-After`, 5xx) and record breadcrumbs.
8. **Batch evaluate** — client-side batching → one HTTP call for N decisions. Requires an atlasent-api `POST /v1/evaluate/batch` endpoint.
9. **Streaming evaluate** — for long-lived agents, keep the connection warm; server-sent events for risk updates.
10. **Go parity** — match TS's observer pattern (middleware, gRPC interceptors).
11. **MCP server bump** — co-versioning with the SDK so `claude_desktop_config.json` entries don't drift.

## Publishing mechanics

- **npm**: `@atlasent/sdk`, `@atlasent/types`, `@atlasent/verify`, `@atlasent/cli`, `@atlasent/packs`. Workflow: `.github/workflows/release.yml` on tag push. `NPM_TOKEN` secret required (check if set).
- **PyPI**: `atlasent`. Workflow on tag. `PYPI_TOKEN` secret.
- **Go proxy**: tag `go/v1.0.0` (Go modules resolve from git tags; no workflow needed beyond the tag).

## Cross-repo dependencies

- **atlasent-api**: `packages/types/` is the source of truth for wire types; this SDK re-exports. `types-sync` CI in atlasent-api guards against drift.
- **atlasent-console**: imports `@atlasent/sdk` and `@atlasent/types`. Version-lock at GA.
- **atlasent-action**: bundles `@atlasent/sdk`. Pin at v1.
- **atlasent-examples**: imports published packages to demo real customer flow.

## Open questions

- Semantic-versioning cadence after v1: monthly minors or cut whenever features land?
- Do we publish `@atlasent/cli` on npm or keep it internal? (It's useful for policy-as-code workflows.)
- Go SDK module path — keep `/go` subdirectory or split into its own repo? Subdirectory is simpler; customers don't mind.
