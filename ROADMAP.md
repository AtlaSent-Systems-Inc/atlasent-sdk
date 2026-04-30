# atlasent-sdk — v1 ship plan

Client SDKs: TypeScript (`@atlasent/sdk`), Python (`atlasent`), Go (`github.com/AtlaSent-Systems-Inc/atlasent-sdk/go`). Nothing ships to customers until these ship.

## GA (v1) — status

1. **TS SDK publish** — `@atlasent/sdk` v1.4.0 sits on `main`; **not yet published to npm**. `@atlasent/types` lives in `atlasent-api/packages/types`; whether it ships as a separate npm package or folds into `@atlasent/sdk` is open (see atlasent-api reconciliation issue).
2. ✅ **Python SDK published** — `atlasent` **1.4.1 on PyPI** (2026-04-26). Sync + async clients, `protect()` / `authorize()` / `gate()` / `evaluate()` / `verify()`, `@atlasent_guard` + `@async_atlasent_guard` decorators, typed errors, `TTLCache`, audit-bundle verification.
3. **Go SDK publish** — pending. Code currently lives in archived `atlasent-sdk-go` repo; planned home per this ROADMAP is `github.com/AtlaSent-Systems-Inc/atlasent-sdk/go`, but the `go/` subdirectory does not exist in this repo yet.
4. **v1-only API sweep** — done in 1.x line; v2 work is gated behind `claude/v2-*` draft branches.
5. **Offline verifier** — `verify_audit_bundle()` ships as part of `atlasent` (Python) and TS SDK. A separate `@atlasent/verify` zero-dep Node CLI is still desired but not yet packaged.
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

## Per-repo task slice — atlasent meta-repo plans (2026-04-30)

Tasks below are copied from the umbrella atlasent meta-repo planning docs so
contributors landing changes here see only the slice targeting this repo.
Authoritative deadlines and acceptance criteria stay in the umbrella docs:

- [`docs/LAST_20_EXECUTION_PLAN.md`](https://github.com/AtlaSent-Systems-Inc/atlasent/blob/main/docs/LAST_20_EXECUTION_PLAN.md)
- [`docs/V1_FINISH_LINE_2026-04-25.md`](https://github.com/AtlaSent-Systems-Inc/atlasent/blob/main/docs/V1_FINISH_LINE_2026-04-25.md)

### From `LAST_20_EXECUTION_PLAN.md`

| # | Task | Done when | Target |
|---|---|---|---|
| A3 | Remove any local re-declaration of decision/permit shapes; consume `@atlasent/types` (TS) or codegen-from-spec (Py/Go). | `grep -R 'type Decision' sdk/` returns one source per language. | 05-04 |
| B2 (TS) | Tighten `withPermit` so `verifyPermit` runs **before** the wrapped function and throws `PermitVerificationError` on any non-`consumed=true` response. | Existing tests still pass; new replay-attempt test added. | 05-02 |
| B3 (Py) | Mirror B2 in `atlasent` and `atlasent.aio`. Same error class names. | `python/tests/` covers replay + expiry; CI green. | 05-04 |
| B4 (Go) | Same surface in Go: `WithPermit(ctx, req, fn)`; replay test in `_test.go`. | Test added; module tagged. | 05-06 |
| C2 | Make the fail-closed matrix executable: a shared "fail-closed conformance" test suite that each SDK runs against the HTTP mock (network error, 5xx, timeout, malformed body, replay → all throw, `fn` never runs). | Suite green in TS, Py, Go CIs. | 05-05 |
| D4 | `withPermit` distinguishes `revoked` from `expired` in the thrown error; document operator runbook. | Error class added; docs updated. | 05-09 |

### From `V1_FINISH_LINE_2026-04-25.md`

**Section C — SDK 1.5.0 release (atlasent-sdk #83, currently a draft):**

Ships the artifacts that directly unlock an enterprise sales demo:

- `audits.list` (audit listing)
- Signed exports (KMS-backed)
- Offline verifier CLI (`@atlasent/verify`)

Disposition action: ship by end of week.

**Explicitly NOT in scope for v1 finish (stay in draft):**

- Pillar 9 Verifiable Proof System — atlasent-sdk #99–100
- Batch / streaming / GraphQL — atlasent-sdk #77–99
- Temporal / OTel / Sentry preview wrappers — atlasent-sdk #79–92
