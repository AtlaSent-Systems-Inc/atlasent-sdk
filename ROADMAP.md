# atlasent-sdk — v1 ship plan

Client SDKs: TypeScript (`@atlasent/sdk`), Python (`atlasent`), Go (`github.com/AtlaSent-Systems-Inc/atlasent-sdk/go`). Nothing ships to customers until these ship.

## GA (v1) — must ship

Status snapshot (2026-04-25):

1. **TS SDK publish** — 🚫 BLOCKED on `NPM_TOKEN` (Waqas). Code is at `typescript/package.json` v1.4.0, `publish-npm.yml` workflow exists. Tag → publish.
2. **Python SDK publish** — 🚫 BLOCKED on `PYPI_TOKEN` (Waqas). Code is at `python/_version.py` v1.4.0, `publish-pypi.yml` workflow exists. Tag → publish.
3. **Go SDK publish** — ✅ DONE (scaffold). `go/go.mod`, `go/client.go`, `go/types.go`, `go/client_test.go`, `go/doc.go`, `go/README.md` all in place; `go build / vet / test` green; coverage 96.8%. Tag `go/v1.0.0` to publish — Go modules resolve from git tags, no workflow needed.
4. **v1-only API sweep** — ✅ DONE. No `v2` references in `typescript/src/` or `python/atlasent/` source. (Roadmap docs reference "v2" planning waves; that's intentional.)
5. **Offline verifier** — ✅ DONE. Carved out into `typescript/packages/verify/` as `@atlasent/verify@1.0.0` — zero runtime deps, `bin: atlasent-verify`, dual ESM/CJS, README, 34 tests at 98% line coverage. Main SDK re-exports `verifyBundle` so existing consumers keep working; bumped to `1.4.1`.
6. **SSO-aware types** — ✅ DONE (in this SDK). `SsoConnection`, `SsoJitRule`, `SsoEvent` (+ `SsoProtocol`, `SsoCanonicalRole`, `SsoEventType`) exported from `@atlasent/sdk` and from `atlasent` (Python). New `client.sso.events.list({…})` namespace on both. Upstream sync TODO: also publish from `atlasent-api/packages/types/src/index.ts` so the SDK becomes a thin mirror like the audit surface is today.

### Movable now (no external dependencies)

_All clear — items 3, 5, 6 above shipped on this branch. Remaining items wait on external secrets._

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
