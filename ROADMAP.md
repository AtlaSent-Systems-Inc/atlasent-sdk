# atlasent-sdk — v1 ship plan

Client SDKs: TypeScript (`@atlasent/sdk`), Python (`atlasent`), Go (`github.com/AtlaSent-Systems-Inc/atlasent-sdk/go`). Nothing ships to customers until these ship.

## GA (v1) — status

1. **TS SDK publish** — `@atlasent/sdk` v1.4.0 sits on `main`; **not yet published to npm**. `@atlasent/types` lives in `atlasent-api/packages/types`; whether it ships as a separate npm package or folds into `@atlasent/sdk` is open (see atlasent-api reconciliation issue).
2. ✅ **Python SDK published** — `atlasent` **1.4.1 on PyPI** (2026-04-26). Sync + async clients, `protect()` / `authorize()` / `gate()` / `evaluate()` / `verify()`, `@atlasent_guard` + `@async_atlasent_guard` decorators, typed errors, `TTLCache`, audit-bundle verification.
3. **Go SDK publish** — skeleton landed in `go/` (2026-04-29). `Client`, `Evaluate`, `VerifyPermit`, `AtlaSentError`, all contract vectors green (`go test ./...`). **Not yet published**: needs a `go/v1.0.0` git tag after PR #121 merges (Go proxy resolves from tags, no workflow required). See `contract/SDK_COMPATIBILITY.md` → "Go SDK" section.
4. **v1-only API sweep** — done in 1.x line; v2 work is gated behind `claude/v2-*` draft branches.
5. ✅ **Offline verifier** — `verify_audit_bundle()` ships as part of `atlasent` (Python) and TS SDK. `@atlasent/verify` zero-dep Node CLI + library landed in `typescript/packages/verify/` (2026-04-29): `atlasent-verify <bundle.json> --key <pem>`, exits 0/1/2, `--json` flag, 15 tests green. Not yet published to npm.
6. **SSO-aware types** — once `atlasent-api/v1-sso` ships, export `SsoConnection`, `SsoJitRule`, `SsoEvent` from `@atlasent/types`.

## Post-GA — ordered by impact

7. ✅ **Retries with jitter + Sentry breadcrumbs** — `AtlaSentClient` retries 429+`Retry-After` and 5xx with capped-exponential full-jitter backoff. `onRetry` hook decouples observability; `@atlasent/sentry` wires it to Sentry breadcrumbs via `makeSentryOnRetry()`. Landed 2026-04-29.
8. **Batch evaluate** — client-side batching → one HTTP call for N decisions. Requires an atlasent-api `POST /v1/evaluate/batch` endpoint.
9. **Streaming evaluate** — for long-lived agents, keep the connection warm; server-sent events for risk updates.
10. ✅ **Go parity** — retry loop + `OnRetry` hook wired into Go `Client`; `Protect()` combines Evaluate + VerifyPermit (mirrors TS `protect()`); `Guard()` returns a `net/http` middleware with `PermitContextKey` + `PermitFromContext` helpers. `DeniedError` wraps `*AtlaSentError` via `Unwrap()`. Landed 2026-04-29.
11. ✅ **MCP server** — `@atlasent/mcp` package in `typescript/packages/mcp/`. Exposes four tools (`atlasent_evaluate`, `atlasent_protect`, `atlasent_verify_permit`, `atlasent_key_self`) over stdio MCP transport. `npx @atlasent/mcp` entry point reads `ATLASENT_API_KEY` from env. Version co-pins with `@atlasent/sdk` (both 1.5.1). 16 tests green. Not yet published to npm.

## Publishing mechanics

- **npm**: `@atlasent/sdk`, `@atlasent/types`, `@atlasent/verify`, `@atlasent/cli`, `@atlasent/packs`. Workflow: `.github/workflows/release.yml` on tag push. `NPM_TOKEN` secret required (check if set).
- **PyPI**: `atlasent`. Workflow on tag. `PYPI_TOKEN` secret.
- **Go proxy**: tag `go/v1.0.0` (Go modules resolve from git tags; no workflow needed beyond the tag).

## Cross-repo dependencies

- **atlasent-api**: `packages/types/` is the source of truth for wire types; this SDK re-exports. `types-sync` CI in atlasent-api guards against drift.
- **atlasent-console**: imports `@atlasent/sdk` and `@atlasent/types`. Version-lock at GA.
- **atlasent-action**: bundles `@atlasent/sdk`. Pin at v1.
- **atlasent-examples**: imports published packages to demo real customer flow.

## Wave F (AI framework guards)

- ✅ **`@atlasent/anthropic-middleware`** — reference Wave F implementation. `withAtlaSentGuard(tools, client, opts)` wraps Anthropic SDK tool definitions with authorize-first `execute` (evaluate + verifyPermit before each tool call). `runGuardedLoop(opts)` runs the complete Claude tool-use cycle. `onDeny: "tool-result"` surfaces denials as tool results so Claude can adapt; default throws `AtlaSentDeniedError`. 15 tests green. Not yet published.

- ✅ **`@atlasent/openai-middleware`** — OpenAI SDK counterpart. `withOpenAIGuard(tools, client, opts)` wraps OpenAI function-tool definitions (`{type:"function", function:{name,parameters}}`) with the same authorize-first pattern. `runOpenAIGuardedLoop(opts)` runs the full OpenAI tool-call cycle, parsing `tool_calls[].function.arguments` JSON and appending `{role:"tool", tool_call_id, content}` results. `onDeny` / `DenialResult` API identical to the Anthropic package. 16 tests green. Not yet published.

- Semantic-versioning cadence after v1: monthly minors or cut whenever features land?
- Do we publish `@atlasent/cli` on npm or keep it internal? (It's useful for policy-as-code workflows.)
- Go SDK module path — keep `/go` subdirectory or split into its own repo? Subdirectory is simpler; customers don't mind.
