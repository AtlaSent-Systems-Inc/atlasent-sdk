# T-01 decision package: `@atlasent/types` as the SDK's single type source

**Status:** Decision-support material. **Not a decision, not an
implementation.** Prepared per explicit instruction not to start the
migration: gather the facts needed to decide whether, when, and how —
not to do it. Everything below is drawn from direct verification against
`atlasent-sdk`, `atlasent-api`, `atlasent-console`, `atlasent`, and
`atlasent-gxp-starter` `main` on 2026-08-22.

**Source finding:** `atlasent#345` (T-02) / `canonical-platform-plan.md`
§T-01 — "`@atlasent/types` name collision between repos." Recommended
canonical term: `@atlasent/types` = `atlasent-api/packages/types` only;
`atlasent-sdk` imports, never redefines. Estimated effort in that doc:
**2-3 days.** This package is the validation of that estimate, not an
assumption of it (see §7).

---

## 0. The headline fact that reframes the whole question

**`@atlasent/types` has never been published to npm.** `npm view
@atlasent/types` returns a 404. `atlasent-api/.github/workflows/publish-types.yml`
exists, is real, gated by the `package.release` AtlaSent action, and
triggers on `types-v*` tags — but no `types-v*` tag has ever been pushed
(`atlasent-api`'s tag list has no `types-v*` entry). `@atlasent/types`'s
own `package.json` is at `0.2.0` — pre-1.0.

**Consequence:** T-01 as literally scoped ("add `@atlasent/types` as a
peer dep in atlasent-sdk") is not currently possible. It requires, as a
genuine prerequisite, a **first-ever publish** of a second, previously
unpublished, unproven package — its own untested release-gate exercise —
before the SDK migration can even begin. This is not "depend on an
existing dependency"; it is "stand up a new publish pipeline, then
immediately build a breaking migration on top of its first release."

## 1. Exactly which public exports would change

`typescript/src/types.ts` has **79 top-level exported symbols**
(interfaces, types, consts) re-exported through the SDK's public entry
point (`typescript/src/index.ts`), making all 79 part of the published
`@atlasent/sdk` npm package's public surface today.

`@atlasent/types` (`atlasent-api/packages/types/src/`) is considerably
larger: **121 exports** in `index.ts` alone, plus more across
`authentication-assurance-v1.ts`, `governance.ts`, `governance-agents.ts`,
`billing-hierarchy.ts`, `assertion-v1.ts`, `governance-release.ts`, and
`context-envelope-v1.ts` — eight source files total vs. the SDK's one.

No full pairwise diff of member shapes was performed (out of scope for a
decision-support pass — that comparison is itself part of the 2-3 day
estimate's real work). What's established:
- The two are **not** a strict subset/superset today — `@atlasent/types`
  is broader (it also serves edge functions and other backend
  consumers), and the SDK's `types.ts` almost certainly has SDK-specific
  conveniences `@atlasent/types` was never meant to carry.
- At least one previously-real divergence (v1 `EvaluateRequest` using
  `agent`/`action` vs. the runtime's `actor_id`/`action_type`) is
  **already resolved** in the SDK today via an explicit compatibility
  bridge (`compat.ts`, verified during `atlasent#345` triage) — so the
  SDK is not simply "wrong" relative to the runtime on the fields that
  matter most; it has already been hand-patched at the field level
  without an import dependency.
- A **contract drift detector already exists**
  (`atlasent-sdk/contract/tools/drift.py`) and runs in CI, but it checks
  a narrower surface than "all 79 vs. all 121": it validates the
  TypeScript and Python SDKs' wire shapes for `/v1-evaluate`,
  `/v1-verify-permit`, `/v1-api-key-self`, and four `/v2/*` endpoints
  against **this repo's own local JSON Schema copies**
  (`contract/schemas/`) — a *third* copy of the truth, not a direct
  comparison against `@atlasent/types`. The other ~70 exports (SSO,
  decisions, audit, governance, connector management, etc.) have **no
  automated drift protection today**, published-or-not.

## 2. Every in-repo consumer/import path affected

### Inside `atlasent-sdk` itself

**31 files** import from `types.ts` (relative imports:
`./types.js` / `../types.js` / `../../src/types.js`), across:
- `typescript/src/*.ts` (17 files: `client.ts`, `protect.ts`, `replay.ts`,
  `trajectory.ts`, `snapshots.ts`, `governanceGraph.ts`,
  `incidentReconstruction.ts`, `orgRiskGraph.ts`,
  `connectorManagement.ts`, `engineVersions.ts`,
  `actionDependencies.ts`, `evidenceEngine.ts`, `index.ts`, +4 more)
- `typescript/packages/{behavior,behavior-emit,behavior-preview,enforce,v2,v2-alpha,v2-preview}/src/*.ts` (14 files across 7 sub-packages)

Every one of these is an internal import path, not a public API surface
— they can be repointed at `@atlasent/types` (or at a local re-export
shim of it) without any external consumer noticing, **provided the
member shapes used stay compatible**.

### External consumers of `@atlasent/sdk`'s named exports (not just the client)

Checked across every repo in this session's scope:

| Repo | Real compile-time named-type imports? | What |
|---|---|---|
| `atlasent-console` | **No** — every `from '@atlasent/sdk'` hit is inside a template-literal *documentation code snippet* rendered to users, not a real import | Zero breaking exposure |
| `atlasent-mcp-server`, `atlasent-llm-integrations`, `atlasent-action`, `behavior-insights`, `atlasent-verify`, `atlasent-control-plane` | **No matches found** | Zero breaking exposure (they don't import from `@atlasent/sdk` at all, or use it exclusively via HTTP/CLI) |
| `atlasent` (core repo) | **Yes**, but only in `examples/src/*.ts` | `AuthorizationDeniedError`, `PermitVerificationError`, `EvaluationPayload` (type-only) — demo/example scripts, typechecked in CI but not shipped runtime code |
| `atlasent-api` | **Yes — the highest-stakes case** | `packages/api-internal`, `packages/otel`, `packages/mcp-server`, `packages/temporal` import `AtlaSentClient`, `EvaluateResponse`, `VerifyResponse`, `ProductionDeployOptions`, `buildProductionDeployRequest` as real production dependencies (15 files) |
| `atlasent-gxp-starter` | **Yes**, small | `VQPClient`, `VQPVerifyResponse`, `AtlaSentClient` (2 files) |

**Net:** the real external blast radius is narrow and concentrated —
`atlasent-api`'s own internal packages are the consumer that actually
matters; `atlasent-gxp-starter` is small; `atlasent` core's exposure is
example code, not production. `atlasent-console` — despite having the
most `@atlasent/sdk` string matches — has **zero** real compile-time
exposure once the documentation-snippet false positives are excluded.
This is exactly the kind of finding that should change scope, and it
was only found by reading the actual matches instead of trusting the
grep count.

## 3. Can compatibility be preserved via aliases/re-exports instead of breaking consumers?

**Likely yes, for most of the surface, but not provably all of it
without the full pairwise diff.** Three options, increasing in safety
and decreasing in "how done is T-01, really":

1. **Full replace + breaking major.** Delete `types.ts`, import
   `@atlasent/types` directly, fix every call site whose shape changed.
   This is what T-01's original wording describes. Breaking for any
   consumer whose imported name or shape changed — narrow blast radius
   per §2, but real (`atlasent-api`'s 15 files, at minimum).
2. **`types.ts` becomes a re-export shim.** Keep every one of the 79
   current export names in `types.ts`, but change their *definitions*
   to `export type { X } from '@atlasent/types'` (or a compatible
   local alias) instead of hand-declaring the shape. Non-breaking for
   any consumer that only imports by name and structurally-compatible
   type — breaking only for the subset where `@atlasent/types`'s shape
   for that name genuinely differs from the SDK's current one. This is
   the version of T-01 actually worth doing: it satisfies "SDK
   re-exports, never redefines independently" (the CLAUDE.md rule this
   finding exists to enforce) without forcing every downstream import
   path to change.
3. **Do nothing yet; extend `drift.py` instead.** Widen the existing
   drift detector to cover the ~70 currently-unprotected exports by
   diffing against `@atlasent/types`' shapes directly (once published),
   without changing `types.ts` at all. Cheapest, lowest-risk, but does
   not resolve the "SDK redefines independently" architecture violation
   — only adds a safety net under it. Worth doing regardless of when
   options 1/2 happen, since it's non-breaking and independent.

Option 2 cannot be fully scoped as "safe" without the pairwise diff
this package does not perform (see §1) — some of the 79 names may turn
out to have genuinely incompatible shapes in `@atlasent/types`, in
which case those specific ones fall back to option 1's breaking path
while the rest take option 2's non-breaking one. **The real deliverable
of "2-3 days" is very likely that diff plus this triage**, not the
mechanical file edit.

## 4. Required `@atlasent/types` dependency/versioning changes

- `@atlasent/types` must be **published to npm for the first time**
  (§0) — push a `types-v0.x.0` tag, which exercises
  `publish-types.yml`'s `package.release` AtlaSent gate for the first
  time on this specific package. This is itself a "real publish/release
  action" this session's instructions say not to perform.
- `@atlasent/types` is pre-1.0 (`0.2.0`). Consuming a pre-1.0 package as
  a `peerDependency` (T-01's original suggested mechanism) is unusual —
  pre-1.0 semver carries no compatibility guarantee across minor bumps
  by convention. Either `@atlasent/types` should reach 1.0 before the
  SDK takes a hard dependency on it, or the SDK's own dependency range
  needs to be pinned tightly (`0.2.x`) and bumped deliberately on every
  `@atlasent/types` release — closer to a `dependency` than a
  `peerDependency` in practice.
- `publish-types.yml`'s own "Verify types mirror sync" step
  (`diff packages/types/src/index.ts supabase/functions/_shared/types.ts`)
  means a stale mirror in `atlasent-api` blocks publishing entirely —
  worth confirming that mirror is currently in sync before relying on
  the publish path working on the first try.

## 5. Test/build/release impact

- **Coverage floors** (`typescript/vitest.config.ts`): set to
  "current-minus-small-margin," explicitly to catch regressions. A
  large mechanical type-source-swap that changes which lines exist
  (deleting hand-written interfaces, adding re-export statements) risks
  tripping this floor in either direction and needs a deliberate
  re-baseline, not just "make tests pass."
- **Build**: `tsup` (`npm run build`). Re-exporting from an external
  package instead of declaring locally is a normal `tsup`/`tsc`
  pattern — no known tooling blocker, but `.d.ts` output should be
  diffed before/after to confirm downstream `.d.ts` consumers (e.g.
  `atlasent-api`'s `tsc` builds) see no unexpected shape change.
  `prepublishOnly` already runs `clean && typecheck && test && build` —
  a real end-to-end gate exists to catch build regressions before an
  actual `npm publish`, which is reassuring for whenever this ships.
- **CI**: `contract/tools/drift.py` needs to keep passing — it validates
  a narrower but real surface (§1) independent of this refactor.
- **Cross-repo test impact**: `atlasent-api`'s 15 consumer files
  (`packages/api-internal`, `otel`, `mcp-server`, `temporal`) would need
  their own `tsc`/test runs re-verified against whatever new
  `@atlasent/sdk` version ships — that's a downstream-repo CI concern,
  not just this repo's.

## 6. Recommended semver/release sequence

Given §0-§5, the sequence that minimizes stacked risk:

1. **Publish `@atlasent/types` for the first time**, as its own
   isolated, low-stakes release (`types-v0.2.0` or similar) — proves the
   never-before-exercised `publish-types.yml` pipeline and the
   `package.release` gate on this specific package, independent of any
   SDK change. Confirm the "types mirror sync" check passes cleanly.
2. **Extend `contract/tools/drift.py`** (§3 option 3) to cover the full
   export surface against the now-published `@atlasent/types`, as a
   non-breaking safety net. This alone closes most of the real risk T-01
   exists to address — a bug in `@atlasent/sdk`'s hand-copied types
   silently diverging from the runtime — without any breaking change.
3. **Do the pairwise diff** (§1's missing piece) against the published
   package, now with real installed types to compare rather than
   reading two files by hand. This produces the actual "which 79 are
   safe as re-exports, which aren't" answer §3 couldn't give.
4. **Land `types.ts` as a re-export shim** (§3 option 2) for whatever
   the diff shows is compatible, as a **minor** SDK release (no public
   name or shape change for consumers) — this is very likely the bulk
   of the 79.
5. **Handle the incompatible remainder** (if any) as an explicit,
   narrow, called-out **major** SDK release, migrating only the names
   that actually changed shape — not a wholesale major bump for the
   entire package.

This sequencing turns one large breaking change into (at most) one
small breaking change plus several non-breaking ones, and produces real
evidence (the diff, the drift-detector extension) rather than an
estimate.

## 7. Should this wait until after the v2.21.0 live-publish proof?

**Yes.** `typescript/package.json` is already staged at `2.21.0`, but no
`sdk-v2.21.0` (or `typescript-v2.21.0`) tag has ever been pushed, and no
`release: v2.21.0 publication evidence` tracking issue exists — the
pattern this org uses for every prior release (`sdk-v2.10.0` /
`typescript-v2.10.0` both have one, per issue #286). So `@atlasent/sdk`'s
**own** release pipeline has an unproven step sitting in front of it
right now. Stacking T-01's own new, never-before-exercised
`@atlasent/types` first-publish (§0) and a subsequent breaking-or-not
SDK release on top of an already-unproven pipeline compounds two
unknowns instead of resolving one at a time. Step 1 of §6 (publish
`@atlasent/types` in isolation) can happen independently of the v2.21.0
proof, but steps 4-5 (the actual SDK-side change, minor or major)
should wait until v2.21.0 is confirmed published and its own evidence
issue closed.

## 8. On the "2-3 days" estimate

**Not validated as-is; likely a floor for step 1 (publish) + step 2
(drift-detector extension) only.** The estimate predates the discovery
that:
- `@atlasent/types` isn't published (a real prerequisite step with its
  own gate, not assumed effort in the original 2-3 day figure).
- The full 79-vs-121 pairwise shape diff has never been done — the
  actual "is this safe as a re-export" answer for each of the 79 names
  is unknown, not merely undocumented.
- `atlasent-api`'s 15-file real consumer surface needs its own
  post-change verification, which is a second repo's CI, not this
  one's.

A defensible estimate for the **full** sequence in §6 (publish through
step 5) is closer to **1-2 weeks** including the first-time
`@atlasent/types` publish, the diff, the drift-detector extension, and
a downstream verification pass in `atlasent-api` — not 2-3 days. Steps
1-2 alone (publish + drift-detector extension, both non-breaking) are
plausibly closer to the original 2-3 day estimate on their own.

## References

- `atlasent#345` (T-02) — where this session found the "2-3 days"
  estimate and the T-01 dependency, and separately found the acute
  field-name-mismatch risk T-02 originally warned about is already
  resolved via `compat.ts`.
- `atlasent/docs/canonical-platform-plan.md` §T-01.
- `atlasent-api/.github/workflows/publish-types.yml` — the untested
  publish pipeline.
- `atlasent-sdk/contract/tools/drift.py` — the existing, narrower drift
  detector.
- `atlasent-sdk/CLAUDE.md` — "Wire types source of truth is
  `atlasent-api/packages/types/`. SDK re-exports; never redefines
  independently." (the rule this finding exists to satisfy)
