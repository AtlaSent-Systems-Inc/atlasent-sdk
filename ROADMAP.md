# atlasent-sdk — v1 ship plan

Client SDKs: TypeScript (`@atlasent/sdk`), Python (`atlasent`). Nothing ships to customers until these ship.

## V1 Status — May 2026

✅ **v1.6.0 shipped** — Go SDK included, `AtlaSentDeniedError.outcome` added
🗑️ **Go SDK removed** (PR #143) — will be re-added on customer demand; not blocking V1
🔄 **SDK 2.0.0** (PR #140) ready to merge — canonical wire shape
🔄 **SDK 2.1.0** (PR #141) ready to merge — builds on 2.0.0

📋 V1 remaining:
- Merge PR #140 (2.0.0 — canonical wire shape)
- Merge PR #141 (2.1.0 — builds on 2.0.0)
- Publish `@atlasent/sdk` to npm
- Publish `atlasent` to PyPI (already at 1.4.1; cut new version after PR chain)

⚠️ Known gaps (post-V1 targets):
- TS retry logic with jitter (v2.2 target)
- Unified decision type across TS + Python
- Browser guard (prevent accidental API key exposure in browser bundles)

## GA (v1) — status

1. **TS SDK publish** — `@atlasent/sdk` v1.6.0 on `main`; **not yet published to npm**. PR #140 (2.0.0) and PR #141 (2.1.0) are ready to merge and will carry the canonical wire shape. Merge PR chain then publish. `@atlasent/types` lives in `atlasent-api/packages/types`; whether it ships as a separate npm package or folds into `@atlasent/sdk` is open (see atlasent-api reconciliation issue).
2. ✅ **Python SDK published** — `atlasent` **1.4.1 on PyPI** (2026-04-26). Sync + async clients, `protect()` / `authorize()` / `gate()` / `evaluate()` / `verify()`, `@atlasent_guard` + `@async_atlasent_guard` decorators, typed errors, `TTLCache`, audit-bundle verification.
3. ~~**Go SDK publish**~~ — v1.6.0 shipped Go SDK; subsequently removed via PR #143. Will be re-added as a separate module on customer demand.
4. ✅ **v1-only API sweep** — done in 1.x line.
5. ✅ **Offline verifier** — `@atlasent/verify` zero-dep Node CLI + library packaged in PR #128. `verify_audit_bundle()` also ships as part of `atlasent` (Python) and TS SDK.
6. **SSO-aware types** — once `atlasent-api/v1-sso` ships, export `SsoConnection`, `SsoJitRule`, `SsoEvent` from `@atlasent/types`.

## Post-GA — ordered by impact

7. **Retries with jitter + Sentry breadcrumbs** — the `authorize()` call should retry transient failures (429 with `Retry-After`, 5xx) and record breadcrumbs. *(v2.2 target)*
8. **Unified decision type** — consistent shape across TS and Python SDKs.
9. **Browser guard** — prevent accidental API key exposure in browser bundles; add bundler warning.
10. **Batch evaluate** — client-side batching → one HTTP call for N decisions. Requires an atlasent-api `POST /v1/evaluate/batch` endpoint.
11. **Streaming evaluate** — for long-lived agents, keep the connection warm; server-sent events for risk updates.
12. **Go parity** — re-add Go SDK (post-V1, on customer demand) and match TS's observer pattern (middleware, gRPC interceptors).
13. **MCP server bump** — co-versioning with the SDK so `claude_desktop_config.json` entries don't drift.

## Publishing mechanics

- **npm**: `@atlasent/sdk`, `@atlasent/types`, `@atlasent/verify`, `@atlasent/cli`, `@atlasent/packs`. Workflow: `.github/workflows/release.yml` on tag push. `NPM_TOKEN` secret required (check if set).
- **PyPI**: `atlasent`. Workflow on tag. `PYPI_TOKEN` secret.
- **Go proxy**: removed for now (PR #143); will restore as `go/v1.0.0` tag when re-added.

## Cross-repo dependencies

- **atlasent-api**: `packages/types/` is the source of truth for wire types; this SDK re-exports. `types-sync` CI in atlasent-api guards against drift.
- **atlasent-console**: imports `@atlasent/sdk` and `@atlasent/types`. Version-lock at GA.
- **atlasent-action**: bundles `@atlasent/sdk`. Pin at v1.
- **atlasent-examples**: imports published packages to demo real customer flow.

## Wave F (AI framework guards)

- ✅ **`@atlasent/langchain`** — `withLangChainGuard(tools, client, opts)` wraps LangChain-style tool definitions (`name`, `description`, `schema?`, `execute`) with authorize-first execute. Returns strings per LangChain convention; JSON object results annotated with permit metadata; plain strings pass through unchanged. Zero dependency on `@langchain/core` — the wrapped `execute` is passed to `DynamicStructuredTool` or any LangChain tool factory. 13 tests green. Not yet published.

- ✅ **`@atlasent/llamaindex`** — `withLlamaIndexGuard(tools, client, opts)` wraps LlamaIndex-style tool definitions (`metadata.{name,description,parameters?}`, `execute`). Returns `unknown` per LlamaIndex convention; object results annotated, arrays and primitives pass through. Zero dependency on `llamaindex` — wrapped `execute` is passed to `FunctionTool.from()` or used in `AgentRunner`. 13 tests green. Not yet published.

- ✅ **`@atlasent/cursor`** — `withCursorGuard(tools, client, opts)` wraps Cursor agent tools (MCP-style: flat `parameters` JSON Schema, string return). JSON object string results annotated with permit metadata; plain text passes through. Integrates with Cursor MCP server `CallToolRequestSchema` handlers. 13 tests green. Not yet published.

## Open questions

- Semantic-versioning cadence after v1: monthly minors or cut whenever features land?
- Do we publish `@atlasent/cli` on npm or keep it internal? (It's useful for policy-as-code workflows.)
