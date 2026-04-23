# atlasent-sdk — v1 ship plan

Client SDKs: TypeScript (`@atlasent/sdk`), Python (`atlasent`), Go (`github.com/AtlaSent-Systems-Inc/atlasent-sdk/go`). Nothing ships to customers until these ship.

## GA (v1) — must ship

1. **TS SDK publish** — `@atlasent/sdk` v1.0.0 to npm. `@atlasent/types` v1.0.0 as a separate package (already wired via `packages/types/` in `atlasent-api`; keep that as the source of truth, `atlasent-sdk` re-exports).
2. **Python SDK publish** — `atlasent` v1.0.0 to PyPI. Sync + async clients, `@guard` decorator, typed errors, caching layer.
3. **Go SDK publish** — `github.com/AtlaSent-Systems-Inc/atlasent-sdk/go` v1.0.0 module publish (Go modules are tag-based; just cut the tag).
4. **v1-only API sweep** — make sure every client method maps to a `/v1/*` endpoint; remove any experimental methods that were pointing at the retired v2 idea.
5. **Offline verifier** — standalone, zero-dep Node verifier (`verifyAuditExport()`) is already in `atlasent-api/scripts/verify-export.mjs`. Package as a separate npm module (`@atlasent/verify`) so auditors can `npx @atlasent/verify bundle.json` without installing the full SDK.
6. **SSO-aware types** — once `atlasent-api/v1-sso` ships, export `SsoConnection`, `SsoJitRule`, `SsoEvent` from `@atlasent/types`.

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
