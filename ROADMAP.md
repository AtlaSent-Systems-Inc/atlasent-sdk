# atlasent-sdk — Roadmap

> **Doctrine reference.** Per [`atlasent/VERSIONING_DOCTRINE.md`](https://github.com/AtlaSent-Systems-Inc/atlasent/blob/claude/normalize-roadmap-versioning-NWPuP/VERSIONING_DOCTRINE.md)
> (2026-05-18 normalization), the public AtlaSent contract is **v1**
> and stays `v1`. There is no "v2 platform" and no "v3 platform"; what
> previous drafts called `v2 / v3` is now sequenced as **Phase 1 /
> Phase 2 / Phase 3** of additive evolution on `v1`. **Per-language
> SDK package SemVer is independent of platform phases** per Doctrine 5:
> `@atlasent/sdk@2.x`, Python `atlasent` 2.x, and Go module `/v2`
> suffix are SDK ergonomics/typing majors — they are **not** "AtlaSent
> v2." Package names like `@atlasent/sdk-v2-preview`,
> `@atlasent/sdk-v2-alpha`, `atlasent_v2_alpha`, `atlasent_v2_preview`,
> the `@atlasent/temporal-preview` / `@atlasent/otel-preview` /
> `@atlasent/sentry-preview` / `@atlasent/behavior-preview` packages,
> and schema-version artifacts under `contract/vectors/v2/` and
> `contract/schemas/v2/` are **code-level identifiers** — preserved
> per Doctrines 3, 4, and 5.
>
> **Last updated:** 2026-05-22

Client SDKs: TypeScript (`@atlasent/sdk`), Python (`atlasent`). Nothing
ships to customers until these ship. SDK package SemVer evolves
independently of platform phases (see Doctrine 5 above).

## v1 contract status — May 2026

The SDKs implement the stable AtlaSent **v1** contract
(`evaluate → permit → verify → audit`).

- **Python `atlasent` 2.0.0** on PyPI — implements the `v1` contract on
  the canonical wire shape. 1.4.1 (2026-04-26) remains installable.
- **TypeScript `@atlasent/sdk` 2.5.0** on npm (`latest` tag) —
  implements the `v1` contract on the canonical wire shape.
- **Go SDK** shipped in v1.6.0, then **removed** (PR #143) — will be
  re-added on customer demand.
- **`@atlasent/sdk` 2.x** — PR #140 (canonical wire shape) and PR #141
  (2.1.0) are merged; the 2.x line is published and live on npm through
  2.5.0. Per Doctrine 5 the SDK SemVer major is **not** "AtlaSent v2."
- **`@atlasent/behavior@1.0.0` and the standalone `@atlasent/types`
  package** — ship-ready but **not yet published to npm**. The behavior
  helper is re-exported from `@atlasent/sdk/behavior`, which is
  published as part of `@atlasent/sdk`.
- **Framework guard packages** (`@atlasent/langchain`,
  `@atlasent/llamaindex`, `@atlasent/cursor`) — tests green, README +
  LICENSE in place; **not yet published to npm** (pending the org-wide
  license decision).

Remaining to close out the current SDK-publishing arc:

- Publish `@atlasent/behavior@1.0.0` and the standalone `@atlasent/types`
  package to npm.
- Publish framework guard packages — unblocks agent-framework pilot
  scenarios.

Known gaps tracked for later phases:

- TS retry logic with jitter.
- Unified decision type across TS + Python.
- Browser guard (prevent accidental API key exposure in browser
  bundles).

## Phase 1 — Stabilization & Pilot Readiness (SDK slice)

Additive on the `v1` contract. The SDKs ship the stable `v1` surface
plus the framework guards required for pilot deployments.

1. **TS SDK published** — `@atlasent/sdk` **2.5.0 on npm** (`latest`
   tag). PR #140 (canonical wire shape) and PR #141 (2.1.0) are merged
   and published. `@atlasent/types` lives in
   `atlasent-api/packages/types`; whether the standalone `@atlasent/types`
   package ships separately or folds into `@atlasent/sdk` is open — for
   now the type definitions ship inside `@atlasent/sdk`.
2. **Python SDK published** — `atlasent` **2.0.0 on PyPI**.
   Sync + async clients, `protect()` / `authorize()` / `gate()` /
   `evaluate()` / `verify()`, `@atlasent_guard` + `@async_atlasent_guard`
   decorators, typed errors, `TTLCache`, audit-bundle verification.
3. **Go SDK** — removed via PR #143. Re-add as a separate module on
   customer demand.
4. **`v1`-only API sweep** — done in the 1.x line.
5. **Offline verifier** — `@atlasent/verify` zero-dep Node CLI +
   library packaged in PR #128. `verify_audit_bundle()` ships in both
   `atlasent` (Python) and TS SDK.
6. **SSO-aware types** — once `atlasent-api/v1-sso` ships, export
   `SsoConnection`, `SsoJitRule`, `SsoEvent` from `@atlasent/types`.

### Shipped (Phase 1, through 2026-05-11)

- **Python governance modules** — auditor access, policy certification,
  federation, financial governance.
- **TS governance enforcement helpers** — `GovernanceEnforcementLayer`,
  `APPROVAL_DENY_REASONS` taxonomy, governance-enforcement types;
  re-exported from `src/index.ts`.
- **6 TS regulatory governance gap modules** — cross-org permission,
  anomaly response, budget exceptions, regulatory escalation, financial
  governance, governance graph foundation.
- **Framework guard packages** — all three packages test-green, README
  + LICENSE added:
  - `@atlasent/langchain` — `withLangChainGuard(tools, client, opts)`.
    13 tests green.
  - `@atlasent/llamaindex` — `withLlamaIndexGuard(tools, client, opts)`.
    13 tests green.
  - `@atlasent/cursor` — `withCursorGuard(tools, client, opts)`. 13
    tests green.
- SCIM groups endpoint types mirroring atlasent-api.
- Typed decision/error/outcome models with `body.error` primary surface.
- Sandbox diff, delegation propagation, heterogeneous quorum types.

## Phase 2 — Enterprise Hardening & Runtime Expansion (SDK slice)

Additive on `v1`. Brings the SDKs to enterprise-procurement readiness
on top of the stable contract.

- **Retries with jitter + Sentry breadcrumbs** — the `authorize()` call
  should retry transient failures (429 with `Retry-After`, 5xx) and
  record breadcrumbs.
- **Unified decision type** — consistent shape across TS and Python
  SDKs.
- **Browser guard** — prevent accidental API key exposure in browser
  bundles; add bundler warning.
- **Batch evaluate** — client-side batching → one HTTP call for N
  decisions. Requires an atlasent-api batch endpoint on `/v1`.
- **Streaming evaluate** — for long-lived agents, keep the connection
  warm; server-sent events for risk updates.

## Phase 3 — Execution Assurance & Operational Sovereignty (SDK slice)

Additive on `v1`. Raises the SDK surface to deterministic execution
assurance.

- **Go parity** — re-add Go SDK (on customer demand) and match TS's
  observer pattern (middleware, gRPC interceptors). Module path
  suffix (`/v2`, `/v3`) follows Go's SemVer convention; it tracks the
  SDK contract, not the platform (Doctrine 5).
- **MCP server bump** — co-versioning with the SDK so
  `claude_desktop_config.json` entries don't drift.
- **Offline replay client** — verify a decision via signed bundle
  without backend round-trip; pairs with the deterministic-replay
  capability in Phase 3.

## Publishing mechanics

- **npm**: `@atlasent/sdk`, `@atlasent/types`, `@atlasent/verify`,
  `@atlasent/cli`, `@atlasent/packs`, `@atlasent/langchain`,
  `@atlasent/llamaindex`, `@atlasent/cursor`, and the preview packages
  (`@atlasent/sdk-v2-preview`, `@atlasent/sdk-v2-alpha`,
  `@atlasent/temporal-preview`, `@atlasent/otel-preview`,
  `@atlasent/sentry-preview`, `@atlasent/behavior-preview`). Workflow:
  `.github/workflows/release.yml` on tag push. `NPM_TOKEN` secret
  required. Preview package names are published-identifier-stable per
  Doctrine 5.
- **PyPI**: `atlasent`, plus preview / experimental distributions
  (`atlasent_v2_alpha`, `atlasent_v2_preview`,
  `atlasent_temporal_preview`, `atlasent_otel_preview`,
  `atlasent_sentry_preview`). Workflow on tag. `PYPI_TOKEN` secret.
  Preview distribution names are published-identifier-stable per
  Doctrine 5.
- **Go proxy**: removed for now (PR #143); will restore as a tagged
  module when re-added (module-path suffix per Go SemVer convention).
- **License blocker**: org-wide Apache-2.0 flip pending counsel; all
  package.json currently set to MIT (corrected in PR #216). Framework
  guard packages cannot publish until license decision is finalized and
  all package.json fields + root LICENSE updated atomically.

## Cross-repo dependencies

- **atlasent-api**: `packages/types/` is the source of truth for wire
  types; this SDK re-exports. `types-sync` CI in atlasent-api guards
  against drift.
- **atlasent-console**: imports `@atlasent/sdk` and `@atlasent/types`.
  Version-lock at the relevant SDK release.
- **atlasent-action**: bundles `@atlasent/sdk`. Pin at the relevant
  SDK release.
- **atlasent-examples**: imports published packages to demo real
  customer flow.

## Gaps (identified 2026-05-11)

- **PRs #140 / #141 pending** — canonical wire shape has been ready for
  review; blocking the next npm/PyPI publish and the stable SDK story.
- **Framework guard npm publish blocked** — three packages are
  code-complete but blocked on: (a) license decision, (b) PRs #140 /
  #141 merge so they don't ship on a pre-canonical wire shape.
- **Unified decision type** — TS and Python still diverge on the
  decision object shape; this confuses polyglot users.

## Framework guards (status)

- `@atlasent/langchain` — `withLangChainGuard(tools, client, opts)`
  wraps LangChain-style tool definitions with authorize-first execute.
  Zero dependency on `@langchain/core`. 13 tests green. **Not yet
  published.**

- `@atlasent/llamaindex` — `withLlamaIndexGuard(tools, client, opts)`
  wraps LlamaIndex-style tool definitions. Zero dependency on
  `llamaindex`. 13 tests green. **Not yet published.**

- `@atlasent/cursor` — `withCursorGuard(tools, client, opts)` wraps
  Cursor agent tools (MCP-style). Integrates with Cursor MCP server
  `CallToolRequestSchema` handlers. 13 tests green. **Not yet
  published.**

## Open questions

- Per-SDK SemVer cadence after the current publish arc: monthly minors
  or cut whenever features land?
- Do we publish `@atlasent/cli` on npm or keep it internal?
- License decision (Apache-2.0 vs MIT) — blocks framework guard
  publish.
