# atlasent-sdk — v1 ship plan

Client SDKs: TypeScript (`@atlasent/sdk`), Python (`atlasent`). Nothing ships to customers until these ship.

> **Last updated:** 2026-05-11

## V1 Status — May 2026

✅ **Python `atlasent` 1.4.1** on PyPI (2026-04-26)
✅ **TypeScript `@atlasent/sdk` 1.6.0** on npm
✅ **Go SDK** shipped in v1.6.0, then **removed** (PR #143) — will be re-added on customer demand
🔄 **SDK 2.0.0** (PR #140) ready to merge — canonical wire shape
🔄 **SDK 2.1.0** (PR #141) ready to merge — builds on 2.0.0
✅ **Wave F packages** (`@atlasent/langchain`, `@atlasent/llamaindex`, `@atlasent/cursor`) — tests green, README + LICENSE in place; **not yet published to npm** (pending org-wide Apache-2.0/MIT license decision and PRs #140/#141 merge)

📋 V1 remaining:
- Merge PR #140 (2.0.0 — canonical wire shape)
- Merge PR #141 (2.1.0 — builds on 2.0.0)
- Publish updated `@atlasent/sdk` to npm (post PR chain)
- Publish updated `atlasent` to PyPI (post PR chain)
- Publish Wave F packages (`@atlasent/langchain`, `@atlasent/llamaindex`, `@atlasent/cursor`) — unblocks agent-framework pilot scenarios

⚠️ Known gaps (post-V1 targets):
- TS retry logic with jitter (v2.2 target)
- Unified decision type across TS + Python
- Browser guard (prevent accidental API key exposure in browser bundles)

## GA (v1) — status

1. ✅ **TS SDK published** — `@atlasent/sdk` **1.6.0 on npm**. PR #140 (2.0.0 canonical wire shape) and PR #141 (2.1.0) are ready to merge; merge then re-publish. `@atlasent/types` lives in `atlasent-api/packages/types`; whether it ships as a separate npm package or folds into `@atlasent/sdk` is open.
2. ✅ **Python SDK published** — `atlasent` **1.4.1 on PyPI** (2026-04-26). Sync + async clients, `protect()` / `authorize()` / `gate()` / `evaluate()` / `verify()`, `@atlasent_guard` + `@async_atlasent_guard` decorators, typed errors, `TTLCache`, audit-bundle verification.
3. ❌ ~~**Go SDK**~~ — removed via PR #143. Re-add as a separate module on customer demand.
4. ✅ **v1-only API sweep** — done in 1.x line.
5. ✅ **Offline verifier** — `@atlasent/verify` zero-dep Node CLI + library packaged in PR #128. `verify_audit_bundle()` ships in both `atlasent` (Python) and TS SDK.
6. **SSO-aware types** — once `atlasent-api/v1-sso` ships, export `SsoConnection`, `SsoJitRule`, `SsoEvent` from `@atlasent/types`.

## Shipped (post-GA governance modules, through 2026-05-11)

- **Python governance modules** — auditor access, policy certification, federation, financial governance.
- **TS governance enforcement helpers** — `GovernanceEnforcementLayer`, `APPROVAL_DENY_REASONS` taxonomy, governance-enforcement types; re-exported from `src/index.ts`.
- **6 TS regulatory governance gap modules** — cross-org permission, anomaly response, budget exceptions, regulatory escalation, financial governance, governance graph foundation.
- **Wave F packages** (framework guards) — all three packages test-green, README + LICENSE added:
  - `@atlasent/langchain` — `withLangChainGuard(tools, client, opts)`. 13 tests green.
  - `@atlasent/llamaindex` — `withLlamaIndexGuard(tools, client, opts)`. 13 tests green.
  - `@atlasent/cursor` — `withCursorGuard(tools, client, opts)`. 13 tests green.
- SCIM groups endpoint types mirroring atlasent-api.
- Phase 7 prep: `body.error` primary + typed decision/error/outcome models.
- Sandbox diff, delegation propagation, heterogeneous quorum types.

## Post-GA — ordered by impact

7. **Retries with jitter + Sentry breadcrumbs** — the `authorize()` call should retry transient failures (429 with `Retry-After`, 5xx) and record breadcrumbs. *(v2.2 target)*
8. **Unified decision type** — consistent shape across TS and Python SDKs.
9. **Browser guard** — prevent accidental API key exposure in browser bundles; add bundler warning.
10. **Batch evaluate** — client-side batching → one HTTP call for N decisions. Requires an atlasent-api `POST /v1/evaluate/batch` endpoint.
11. **Streaming evaluate** — for long-lived agents, keep the connection warm; server-sent events for risk updates.
12. **Go parity** — re-add Go SDK (post-V1, on customer demand) and match TS's observer pattern (middleware, gRPC interceptors).
13. **MCP server bump** — co-versioning with the SDK so `claude_desktop_config.json` entries don't drift.

## Publishing mechanics

- **npm**: `@atlasent/sdk`, `@atlasent/types`, `@atlasent/verify`, `@atlasent/cli`, `@atlasent/packs`, `@atlasent/langchain`, `@atlasent/llamaindex`, `@atlasent/cursor`. Workflow: `.github/workflows/release.yml` on tag push. `NPM_TOKEN` secret required.
- **PyPI**: `atlasent`. Workflow on tag. `PYPI_TOKEN` secret.
- **Go proxy**: removed for now (PR #143); will restore as `go/v1.0.0` tag when re-added.
- **License blocker**: org-wide Apache-2.0 flip pending counsel; all package.json currently set to MIT (corrected in PR #216). Wave F packages cannot publish until license decision is finalized and all package.json fields + root LICENSE updated atomically.

## Cross-repo dependencies

- **atlasent-api**: `packages/types/` is the source of truth for wire types; this SDK re-exports. `types-sync` CI in atlasent-api guards against drift.
- **atlasent-console**: imports `@atlasent/sdk` and `@atlasent/types`. Version-lock at GA.
- **atlasent-action**: bundles `@atlasent/sdk`. Pin at v1.
- **atlasent-examples**: imports published packages to demo real customer flow.

## Gaps (identified 2026-05-11)

- **PRs #140/#141 pending** — canonical wire shape has been ready for review; blocking the next npm/PyPI publish and the stable SDK story.
- **Wave F npm publish blocked** — three packages are code-complete but blocked on: (a) license decision, (b) PRs #140/#141 merge so Wave F doesn't ship on a pre-canonical wire shape.
- **Unified decision type** — TS and Python still diverge on the decision object shape; this confuses polyglot users.

## Wave F (AI framework guards)

- ✅ **`@atlasent/langchain`** — `withLangChainGuard(tools, client, opts)` wraps LangChain-style tool definitions with authorize-first execute. Zero dependency on `@langchain/core`. 13 tests green. **Not yet published.**

- ✅ **`@atlasent/llamaindex`** — `withLlamaIndexGuard(tools, client, opts)` wraps LlamaIndex-style tool definitions. Zero dependency on `llamaindex`. 13 tests green. **Not yet published.**

- ✅ **`@atlasent/cursor`** — `withCursorGuard(tools, client, opts)` wraps Cursor agent tools (MCP-style). Integrates with Cursor MCP server `CallToolRequestSchema` handlers. 13 tests green. **Not yet published.**

## Open questions

- Semantic-versioning cadence after v1: monthly minors or cut whenever features land?
- Do we publish `@atlasent/cli` on npm or keep it internal?
- License decision (Apache-2.0 vs MIT) — blocks Wave F publish.
