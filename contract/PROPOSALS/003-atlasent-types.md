# Proposal 003 — `@atlasent/types` npm package

**Status:** `DRAFT`
**Needs decisions from:** `@atlasent` npm scope owner (who can
publish), maintainer(s) of the console / engine repos (who will
consume it).

## Problem statement

The TypeScript SDK currently defines `Decision`, `EvaluateRequest`,
`EvaluateResponse`, `VerifyPermitRequest`, `VerifyPermitResponse`,
and the error-code union `AtlaSentErrorCode` in
`typescript/src/types.ts`. V1_PLAN calls for those to move to a
shared `@atlasent/types` package so:

- The console (separate repo, per
  `contract/SDK_COMPATIBILITY.md`) can import the exact same types
  without duplicating them.
- The policy engine / downstream services can type-check their
  handlers against the same definitions.
- Drift between repos becomes a compile error (type mismatch), not
  a runtime wire mismatch that only the SDK drift detector catches.

The SDK's local types are the de facto source of truth today. This
proposal extracts them and specifies the migration.

## Proposed package

**Name:** `@atlasent/types`
**Initial version:** `0.1.0` (pre-stable; `>=1.0.0` once adopted
across all three consumer repos).
**License:** MIT (liberal because this is just type definitions; no
runtime code).
**Repository:** new repo `atlasent-types` under the
`AtlaSent-Systems-Inc` org — single-purpose, tiny, publishes from a
`main` branch protected to maintainer pushes only. Monorepo-inside-
this-repo is **rejected** because the package must be publishable
independently of SDK releases (types change more slowly than SDK
APIs, and consumers want a narrow dep).

## Package contents

Three modules, no runtime code, no build step beyond `tsc --emitDeclarationOnly`:

```
@atlasent/types
├── src/
│   ├── index.ts         # re-exports everything below
│   ├── wire.ts          # wire-level types (exact JSON shapes)
│   └── domain.ts        # camelCase SDK-facing types
├── package.json
├── tsconfig.json        # strict, declaration-only output
└── README.md
```

### `wire.ts` — the canonical wire shapes

One TS interface per JSON Schema in `contract/schemas/`:

```ts
export interface EvaluateRequestWire {
  action: string;
  agent: string;
  context: Record<string, unknown>;
  api_key: string;
}

export interface EvaluateResponseWire {
  permitted: boolean;
  decision_id: string;
  reason?: string;
  audit_hash?: string;
  timestamp?: string;
}

// VerifyPermitRequestWire, VerifyPermitResponseWire, ErrorResponseWire
```

These interfaces are **generated** from `contract/openapi.yaml` using
`openapi-typescript` (or `json-schema-to-typescript` as a fallback).
Regeneration runs in CI on every `atlasent-sdk` release that touches
the contract, and the generated file is committed to the types repo.

### `domain.ts` — the SDK-facing camelCase types

Hand-written thin wrappers matching today's `typescript/src/types.ts`:

```ts
import type { EvaluateRequestWire, EvaluateResponseWire } from "./wire.js";

export type Decision = "ALLOW" | "DENY";

export interface EvaluateRequest {
  agent: string;
  action: string;
  context?: Record<string, unknown>;
}

export interface EvaluateResponse {
  decision: Decision;
  permitId: string;
  reason: string;
  auditHash: string;
  timestamp: string;
}

// VerifyPermitRequest, VerifyPermitResponse
```

These are what application code imports. They're the source of truth
for the SDK's public surface.

### `index.ts`

Re-exports everything:

```ts
export * from "./wire.js";
export * from "./domain.js";
```

Consumers pick based on need: wire-level if they're validating
bytes, domain-level if they're consuming SDK return values.

### `package.json` essentials

```json
{
  "name": "@atlasent/types",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./wire": {
      "types": "./dist/wire.d.ts",
      "default": "./dist/wire.js"
    }
  },
  "sideEffects": false
}
```

Subpath `./wire` lets consumers import only the wire types without
pulling in the domain types (and vice versa).

## Open questions

1. **Source of truth for the wire types.** Two paths:
   - **(a) Generate from `contract/openapi.yaml`** every time it
     changes. Requires a CI pipeline between the two repos and a
     small codegen step. Truly DRY.
   - **(b) Hand-maintained, drift-detected.** Same approach as
     today's SDK models — the `contract/tools/drift.py` equivalent
     introspects `@atlasent/types` and fails CI if the TS
     interfaces disagree with the JSON Schemas.
   Proposal recommends (a) — drift detection is a safety net, not
   a design tool.

2. **Who owns the `@atlasent` npm scope?** Needs a named owner with
   publish rights. Without this, nothing else in the proposal can
   move. (Publishing an empty `0.0.1-alpha` stub is a cheap way to
   claim the name.)

3. **Versioning across the three repos.**
   - `atlasent-sdk` depends on `@atlasent/types` as a peer dep or
     regular dep (peer feels wrong for a zero-runtime package;
     regular dep is probably fine).
   - The console and engine repos depend on it too.
   - Types changes that break consumers should be major bumps;
     additive changes are minor; typo fixes are patch.
   - Open: does the SDK pin to an exact version, or use `^`? Exact
     avoids surprise breakage, `^` reduces dep-upgrade churn.
     Proposal: `^` once the package hits 1.0.0; exact while on 0.x.

4. **What about Python?** Python has pydantic models that serve the
   same role. The Python equivalent of this proposal is the
   OpenAPI-driven codegen discussed in `V1_PLAN.md`'s "Type source
   of truth" section; `@atlasent/types` is TS-only.

5. **Should the error taxonomy live here?** The TS `AtlaSentError`
   class has runtime behavior (`instanceof` checks, etc.) so the
   class itself stays in the SDK. But the `AtlaSentErrorCode` union
   type belongs here — it's shared with anyone who catches SDK
   errors. Proposal: yes, export the union type here; keep the
   class in the SDK.

6. **`AtlaSentDeniedError.decision`'s forward-compatible union.**
   The Python + TS SDKs both declare `"deny" | "hold" | "escalate"`
   today for future API behavior. That union should live in
   `@atlasent/types` too so every consumer handles the same values.

## SDK migration plan

Assuming `@atlasent/types@0.1.0` is published:

### Step 1 — Types repo published

Nothing changes in `atlasent-sdk` yet. The package exists as a
read-only mirror of `typescript/src/types.ts`. This lets console /
engine teams start importing it.

### Step 2 — SDK imports instead of defines

In a dedicated PR:

```ts
// typescript/src/types.ts is REMOVED
// typescript/src/index.ts changes from:
export type { EvaluateRequest, ... } from "./types.js";
// to:
export type { EvaluateRequest, ... } from "@atlasent/types";
```

`@atlasent/types` added to `dependencies` (not devDependencies — it
carries the types the SDK's API surface exposes to callers).

`contract/tools/drift.py` updated: instead of introspecting
`typescript/src/types.ts`, it fetches the currently-pinned
`@atlasent/types` package.json version and runs its schema check
against that.

### Step 3 — Removal of duplicate type defs

`typescript/src/types.ts` is deleted. All type-only exports in
`src/index.ts` come from `@atlasent/types`. Drift detector adapts.

### Step 4 — Drift detector improvement

`drift.py` gains a check: `@atlasent/types` package version pinned in
the SDK MUST match the `contract/openapi.yaml` version. Any
mismatch fails CI.

## Error taxonomy impact

No new classes. One type-only export moves locations:

- `AtlaSentErrorCode` (Literal union) → `@atlasent/types`. The
  `AtlaSentError` class stays in the SDK (runtime code).

The `AtlaSentDeniedError` class + its `AtlaSentDecision` type alias
stay in the SDK. Only the underlying `Decision` type
(`"ALLOW" | "DENY"`) moves to `@atlasent/types`, where it already
fits alongside the wire schemas.

## Test vector requirements

Not applicable — this proposal adds no new wire surface. The
existing drift detector on `contract/openapi.yaml` covers the types
indirectly.

One new CI check once the migration completes: a smoke test that
`import { EvaluateRequest } from "@atlasent/types"` in a tiny
throwaway `.ts` file type-checks. Catches misconfigured subpath
exports or broken `dist/` outputs.

## Not in scope for this proposal

- **Non-TS consumers.** The Python side has its own track (OpenAPI
  + pydantic codegen, per V1_PLAN). Go / Ruby / Java SDKs each get
  their own package / module story when those SDKs exist.
- **Runtime validators in the package.** `@atlasent/types` ships
  types only. Runtime validation stays in the SDK (where it's
  already integrated with the `fetch` client and error taxonomy)
  and in `contract/tools/validate_vectors.py` (for CI).
- **Browser-safe types.** Not an issue — types compile to nothing
  at runtime. The SDK proper is still Node-only (per its
  README).
