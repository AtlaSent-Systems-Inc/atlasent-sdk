# atlasent-sdk — v1 ship plan

Client SDKs: TypeScript (`@atlasent/sdk`), Python (`atlasent`). Nothing ships to customers until these ship.

## GA (v1) — status

1. **TS SDK publish** — `@atlasent/sdk` v1.5.1 on `main`; **not yet published to npm**. `@atlasent/types` lives in `atlasent-api/packages/types`; whether it ships as a separate npm package or folds into `@atlasent/sdk` is open (see atlasent-api reconciliation issue).
2. ✅ **Python SDK published** — `atlasent` **1.4.1 on PyPI** (2026-04-26). Sync + async clients, `protect()` / `authorize()` / `gate()` / `evaluate()` / `verify()`, `@atlasent_guard` + `@async_atlasent_guard` decorators, typed errors, `TTLCache`, audit-bundle verification.
3. ✅ **v1-only API sweep** — done in 1.x line.
4. ✅ **Offline verifier** — `@atlasent/verify` zero-dep Node CLI + library. `verify_audit_bundle()` also ships as part of `atlasent` (Python) and TS SDK.
5. **SSO-aware types** — once `atlasent-api/v1-sso` ships, export `SsoConnection`, `SsoJitRule`, `SsoEvent` from `@atlasent/types`.

## Post-GA — ordered by impact

6. **Retries with jitter + Sentry breadcrumbs** — the `authorize()` call should retry transient failures (429 with `Retry-After`, 5xx) and record breadcrumbs.
7. **Batch evaluate** — client-side batching → one HTTP call for N decisions. Requires an atlasent-api `POST /v1/evaluate/batch` endpoint.
8. **Streaming evaluate** — for long-lived agents, keep the connection warm; server-sent events for risk updates.
9. **MCP server bump** — co-versioning with the SDK so `claude_desktop_config.json` entries don't drift.

## Publishing mechanics

- **npm**: `@atlasent/sdk`, `@atlasent/types`, `@atlasent/verify`, `@atlasent/cli`, `@atlasent/packs`. Workflow: `.github/workflows/release.yml` on tag push. `NPM_TOKEN` secret required (check if set).
- **PyPI**: `atlasent`. Workflow on tag. `PYPI_TOKEN` secret.

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
