# Constraint Schema Alignment Plan — SDK ↔ Console ↔ API

Status: **proposal / for review** · Owner: TBD · Date: 2026-05-30

## Architecture decision (settled)

**Policy types move under API ownership.** `atlasent-api/packages/types` becomes
the canonical home for the policy rule/condition types. Ownership flows in one
direction:

```
atlasent-api/packages/types   (canonical — runtime/API is the execution authority)
        │
        ├─► atlasent-sdk        re-exports (never redefines; honors the existing
        │                       "wire types source of truth is atlasent-api" invariant)
        │
        └─► atlasent-console    consumes (drops local ownership of these types)
```

Rationale:
- The **runtime/API is the execution authority** — it evaluates policies, so it
  owns the canonical shape.
- The **console is a consumer**, not an owner. Its
  `packages/types/src/policy.ts` becomes a thin re-export of the API types.
- **SDK re-exports** continue to honor the existing `atlasent-sdk/CLAUDE.md`
  invariant ("wire types source of truth is `atlasent-api/packages/types/`; SDK
  re-exports, never redefines independently").
- **No new shared package** (e.g. `@atlasent/policy-types`) is introduced until
  V1 runtime convergence and semantic stabilization are complete. Extracting a
  standalone package now would freeze a still-moving contract; revisit post-V1.

This resolves the former WS1 "package home" open question in favor of Option 1.

## Scope clarification: two distinct rule systems (added post-WS1)

Investigation during WS4 surfaced a premise this plan originally got wrong. There
are **two separate rule representations** in the platform, not one:

1. **Authoring / storage rule-row model** — `policy_rules` / `rule_conditions` /
   `rule_obligations` tables, the console policy builders, and (as of WS1) the
   canonical `@atlasent/types` policy types. Operators are long-form
   (`equals`, `greater_than`), conditions are a flat `conditions[]` with
   `condition_group` AND/OR grouping. **This is what the plan unifies.**

2. **Runtime rule-engine DSL** — `packages/sdk/src/rules.ts` (kept byte-identical
   to `supabase/functions/_shared/rules.ts` via `rules-sync` CI). This is the
   zero-dependency evaluator that every `/v1-evaluate` call runs. Its language is
   `{templates:[{decision, deny_code, when:{all|any:[{field, eq|gt|gte|lt|…}]}}]}`
   with nestable `all`/`any` combinators. The **21 policy packs author their
   `templates[].rule` in this DSL**, and the seed path stores it verbatim into
   `constraint_bundles.rules`.

These are intentionally different layers: the rule-row model is for *authoring and
storage*; the engine DSL is the *runtime evaluation language*. The packs belong to
system (2), **not** system (1). Converting them to the canonical operator
vocabulary would require rewriting the production rule engine — out of scope and
high-risk.

**Decision (settled):** keep the engine DSL separate. The plan unifies the
authoring/storage model (WS1–WS3) and documents the relationship between the two
systems rather than collapsing them. WS4 is re-scoped accordingly (see below).

## Goal

Today the same "constraint" concept is expressed in several incompatible shapes
across the SDK, the console, and the API. This plan unifies the **authoring /
storage rule-row model** on a **single source of truth: the console/API rule-row
format** (the shape stored in `policy_rules` / `rule_conditions`), and brings the
SDK contract schema into conformance with it.

Note: the **API policy packs** are a *different* system — they author in the
runtime rule-engine DSL (`rules.ts`), not the rule-row model — and are explicitly
**out of scope** for conversion. See "two distinct rule systems" above. The packs
column in the table below is retained only to show where the engine DSL sits
relative to the rule-row model; it is **not** a conversion target.

## Why the rule-row format is canonical

It is the richest and the one that already backs production storage/evaluation:

- 5-value `effect` (`allow | deny | hold | escalate | require_approval`)
- `deny_code` + `deny_reason` for explainability
- `require_approvals` / obligations
- layered-policy columns (`policy_layer`, `tags`, `overrides_policy_id`, …)
- mirrors the DB tables `policy_rules`, `rule_conditions`, `rule_obligations`

The SDK contract schema (`contract/schemas/policy.schema.json`) is strictly
weaker (only `allow`/`deny`, no deny codes, no approvals, nested
`agent`/`action`/`context` matchers), so collapsing *toward* it would lose
information. We align everything *to* the rule-row format instead.

## Current state (the shapes)

Three of the columns below are the rule-row model in different states of
divergence (the unification targets). The **packs** column is the separate runtime
engine DSL, shown for contrast only — *not* a conversion target.

| Aspect | SDK contract (`atlasent-sdk/contract/schemas/policy.schema.json`) | API packs — engine DSL *(separate system, not converted)* | Console UI (`conditions_json`) | Console types (`atlasent-console/packages/types/src/policy.ts`) |
|---|---|---|---|---|
| Rule container | `rules[].match` | `rules.templates[].when` | `conditions_json[]` | `conditions[]` (`RuleCondition`) |
| Field key | nested `agent`/`action`/`context.<f>` | `field` | `field` | `field_path` |
| Equality | `equals` | `eq` | `eq` | `equals` |
| Compare | `gt/gte/lt/lte` | `gt`… inline | `gt/gte/lt/lte` | `greater_than/less_than` |
| Set | `in` | `in` | `in/notIn` | `in/not_in` |
| String | `prefix`, `regex` | — | — | `contains`, `regex` |
| Presence | `exists` | — | `present/missing` | `exists/not_exists` |
| Decision | `effect` (allow/deny) | `decision` + `deny_code` | `effect` (5) | `effect` (5, `RuleEffect`) |
| Approvals | — | `require_approvals` | obligations | obligations |
| Value | inline | inline | `value` | `value_json` |

A constraint authored in any one of these cannot be validated/consumed by the
others.

## Target canonical schema (v1)

A single normalized rule shape, **owned by `atlasent-api/packages/types`**,
hardened into a formal JSON Schema that the SDK re-exports and the console
consumes.

```jsonc
{
  "id": "string",
  "name": "string",
  "description": "string|null",
  "priority": 100,
  "enabled": true,
  "effect": "allow|deny|hold|escalate|require_approval",
  "stop_on_match": true,
  "rationale_template": "string|null",
  "deny_code": "string?",            // promoted to first-class (from packs)
  "require_approvals": 0,            // promoted to first-class (from packs)
  // layered policy
  "policy_layer": "global|domain|environment|action_type|resource|exception",
  "tags": ["string"],
  "overrides_policy_id": "string?",
  "override_reason": "string?",
  "override_scope": "string?",
  "override_expires_at": "iso8601?",
  "resource_type": "string?",
  "resource_id": "string?",
  // conditions (AND within a group; groups OR'd by condition_group)
  "conditions": [
    {
      "condition_group": 0,
      "field_path": "context.environment",   // dotted path; replaces nested match
      "operator": "equals",                  // canonical operator vocabulary
      "value_json": "production"
    }
  ],
  "obligations": [
    { "obligation_type": "string", "config_json": {} }
  ]
}
```

### Canonical operator vocabulary (the one true list)

The canonical, long-form operator set (used for **all storage and wire
formats**):

`equals, not_equals, greater_than, greater_than_or_equal, less_than,
less_than_or_equal, in, not_in, contains, regex, exists, prefix`

Notes:
- adds `greater_than_or_equal` / `less_than_or_equal` (today only `gt/lt` exist
  in console types — gap to close)
- adds `prefix` (only the SDK has it today)
- `exists` replaces the SDK `exists:bool` and console `present/missing`
- **Dropped from the canonical set:** `not_contains` and `not_exists` (present in
  today's console `ConditionOperator`). These are **not** canonical. Any stored
  rule using them must be migrated — `not_exists` → `exists` with negated intent
  handled at the rule level (or a `not_equals`-style rewrite), `not_contains` →
  re-expressed via the negation path. The migration codemod must flag any rule it
  cannot mechanically convert for manual review.

**Shorthand (UI only).** The UI may expose `eq / gt / gte / lt / lte` as
author-friendly shorthand, but these are presentation aliases only. They MUST be
expanded to the canonical long-form names before persistence or transmission —
canonical storage and wire formats never contain shorthand. A single bidirectional
mapping table (shorthand ⇄ canonical) lives with the canonical types in
`atlasent-api/packages/types` and is the only place the aliasing is defined.

| Shorthand (UI) | Canonical (storage/wire) |
|---|---|
| `eq` | `equals` |
| `gt` | `greater_than` |
| `gte` | `greater_than_or_equal` |
| `lt` | `less_than` |
| `lte` | `less_than_or_equal` |

### Decision/effect

Canonical `effect` is the 5-value set. The SDK schema's 2-value `effect` is a
strict subset, so existing SDK policies remain valid after migration.

### Match → conditions mapping

The SDK's nested `match.agent/action/context` collapses to flat
`field_path` conditions:

| SDK match | Canonical condition |
|---|---|
| `agent: {prefix: "clinical-"}` | `{field_path:"agent", operator:"prefix", value_json:"clinical-"}` |
| `action: {in:[...]}` | `{field_path:"action", operator:"in", value_json:[...]}` |
| `context.amount:{lte:10000}` | `{field_path:"context.amount", operator:"less_than_or_equal", value_json:10000}` |
| `require:["x"]` | `{field_path:"context.x", operator:"exists", value_json:true}` |

## Workstreams

### 1. Canonical types in the API (foundation)
- **Move the rule-row types into `atlasent-api/packages/types`.** Today
  `ConditionOperator`/`RuleEffect`/`RuleCondition`/`PolicyRule` are defined only in
  `atlasent-console/packages/types/src/policy.ts`; the API types package exists but
  holds only governance/context types. Add a `policy.ts` (rule-row types +
  canonical operator vocabulary + shorthand mapping table) and export it from the
  package `index.ts`. This makes the API the canonical owner per the architecture
  decision above.
- Author a canonical JSON Schema `policy-rule.schema.json` alongside the TS types
  (single generator so the schema and TS never drift). The API also drops its
  duplicate copy in `_shared/layered-evaluator.ts`, importing from the package
  instead.
- Add JSON Schema validation fixtures (port from `atlasent-sdk/contract/vectors`).
- **Do not** create a new standalone shared package yet — defer until post-V1
  runtime convergence per the architecture decision.

### 2. Console (consumer)
- **Stop owning the types.** Replace the definitions in
  `packages/types/src/policy.ts` with re-exports of the API-owned types. Console
  no longer defines `ConditionOperator`/`RuleEffect`/etc. independently.
- Normalize the builders onto the canonical operator set, expanding the UI
  shorthand (`eq/gt/gte/lt/lte`) to long-form before persistence:
  - `src/pages/PolicyBuilderPage.tsx` — shorthand stays as UI labels only; the
    shared mapping table expands them on serialize.
  - `src/pages/ConstraintBuilder.tsx` — enters the **deprecation path** (see
    below), not a straight migration.
  - `src/components/policy/TemplateEditorModal.tsx` — free-text
    `hold_conditions`/`deny_conditions` → structured canonical conditions.
- Single serialization helper: `toCanonicalRule()` / `fromCanonicalRule()` (using
  the shared shorthand⇄canonical table) used by all builders +
  `src/hooks/usePolicyBundles.ts` + `src/lib/api/rpc-client.ts`.

#### ConstraintBuilder deprecation path
The legacy `src/pages/ConstraintBuilder.tsx` is retired over three releases
rather than cut over in place:

| Phase | Behavior |
|---|---|
| **V1 — dual-accept** | ConstraintBuilder stays editable. On save it emits canonical long-form rules (via `toCanonicalRule()`). API/console accept both legacy and canonical shapes. A deprecation banner points users to PolicyBuilder. |
| **V2 — read-only** | ConstraintBuilder becomes view-only: existing rules render, but no new edits/creates. Users are routed to PolicyBuilder for changes. Legacy-shape writes are rejected; reads still tolerate legacy. |
| **V3 — removal** | The page, its routes, and legacy-only code paths are deleted. By this point all stored rules have been migrated to canonical via the codemod, so legacy read tolerance can also be dropped. |

### 3. SDK
- **Contract-first (hard requirement).** `atlasent-sdk/CLAUDE.md` mandates that
  any change to `/v1-evaluate` / `/v1-verify-permit` wire shapes "must go through
  `contract/schemas/` before SDK code changes", and `contract/tools/drift.py`
  blocks CI on drift. So the canonical schema change lands in
  `contract/schemas/` **first**, and the drift detector must be updated/extended
  to validate against the new rule-row shape.
- Also honor the `rules.ts` byte-identical invariant: `packages/sdk/src/rules.ts`
  must stay identical to the API `_shared/rules.ts` (enforced by `rules-sync`
  CI) — any operator-vocabulary change has to be applied to both copies in
  lockstep.
- Re-point `contract/schemas/policy.schema.json` at (or regenerate it from) the
  API-owned `policy-rule.schema.json`. Keep the old nested-`match` schema as
  `policy.legacy.schema.json` + a `migratePolicyV0toV1()` codemod.
- **Re-export, never redefine.** SDK policy types re-export from
  `atlasent-api/packages/types` (honoring the CLAUDE.md invariant); the SDK adds
  no independent definitions.
- Add a **builder + validator** (new capability — the SDK currently has none):
  `buildRule()`, `validatePolicy()` in `typescript/src/` and the Python
  equivalent in `python/atlasent/`.
- Update `ConstraintTrace`/`buildWhyTrace` (`typescript/src/evidenceEngine.ts`)
  to surface canonical `field_path`/`operator`/`deny_code`.
- Fix the schema file itself: `contract/schemas/policy.schema.json` currently has
  malformed trailing JSON (duplicated closing braces / stray `lt ` `gte ` keys at
  lines ~99–107). Must be repaired as part of this work regardless.

### 4. API / policy packs — **RE-SCOPED** (do NOT convert packs)
Original premise (convert packs from inline `eq` to canonical `conditions[]`) was
**wrong** — see "two distinct rule systems" above. The packs author in the runtime
rule-engine DSL (`rules.ts`), not the rule-row model. Converting them would mean
rewriting the production evaluate path. Re-scoped to documentation + guard rails:
- **Do not** change pack `templates[].rule` shapes or the `rules.ts` DSL.
- Author a **mapping document** describing how the two systems relate: the engine
  DSL operators (`eq/gt/gte/lt/in/…`, `when.all`/`when.any`) vs. the canonical
  rule-row operators (`equals/greater_than/…`, `conditions[]` + `condition_group`),
  and which surfaces use which. Cross-link the canonical shorthand table (the
  engine DSL's `eq/gt` are *coincidentally* the same tokens as the UI shorthand,
  but they live in a different system — call this out to prevent confusion).
- Note the boundary in `packages/packs` and near `rules.ts` so future work does
  not try to "align" the engine DSL onto the rule-row vocabulary without an
  explicit engine-rewrite decision.
- The `policy-rule.schema.json` from WS1 validates the **rule-row** model only; it
  is explicitly **not** applied to pack files.

### 5. Compatibility & rollout
- Ship `migratePolicyV0toV1()` in the SDK; run it over `contract/vectors`.
- Dual-accept window: API validators accept both shapes for one minor version,
  emit a deprecation warning on legacy.
- Version the schema (`schema_version: "1"`) in stored rules and pack files.

## Sequencing

1. WS1 canonical types in `atlasent-api/packages/types` + JSON Schema + fixtures. **(done — PR atlasent-api#1036)**
2. WS4 **re-scoped** to a two-systems mapping doc (no pack conversion).
3. WS3 SDK re-points contract schema, re-exports API types, adds builder/validator + codemod.
4. WS2 console re-exports API types + serialization helper; ConstraintBuilder enters V1 dual-accept.
5. WS5 dual-accept window → ConstraintBuilder V2 read-only → V3 removal; drop legacy schema.

## Resolved decisions

- **Package home** — *Resolved:* canonical home is `atlasent-api/packages/types`
  (API ownership). No new shared package until post-V1 runtime convergence.
  SDK re-exports; console consumes.
- **Operator labels** — *Resolved:* canonical storage/wire uses long-form names;
  UI may show `eq/gt/gte/lt/lte` shorthand, expanded via the shared mapping table
  before persistence.
- **Legacy ConstraintBuilder** — *Resolved:* three-phase deprecation
  (V1 dual-accept → V2 read-only → V3 removal).

## Open questions (remaining)

- **`not_contains` / `not_exists` migration** — confirm the rewrite strategy for
  stored rules using these dropped operators (mechanical vs. manual-review
  fallback).
- **Backfill** — rewrite already-stored rule rows to the versioned canonical
  shape, or tag-and-translate on read until V3?
- **Operator labels**: keep shorthand `eq/gt` as console UI sugar, or surface the
  wordy ops directly to users?
- **Legacy ConstraintBuilder page**: refactor onto canonical, or deprecate/remove?
- **Backfill**: rewrite already-stored rule rows to the versioned shape, or only
  tag-and-translate on read?

## Affected files (index)

- `atlasent-api/packages/types/src/policy.ts` (**new** — canonical rule-row types + operator vocabulary + shorthand map)
- `atlasent-api/packages/types/src/index.ts` (export policy types)
- `atlasent-api/packages/types/.../policy-rule.schema.json` (**new** — canonical JSON Schema)
- `atlasent-api/supabase/functions/_shared/layered-evaluator.ts` (drop duplicate types; import from package)
- `atlasent-api/packages/packs/src/packs/*` (21 packs convert)
- `atlasent-api/packages/packs/src/index.ts` (+ build-time validator)
- `atlasent-sdk/contract/schemas/policy.schema.json` (re-point at canonical + repair malformed JSON)
- `atlasent-sdk/contract/vectors/policies/*.json` (migrate)
- `atlasent-sdk/typescript/src/{types.ts,evidenceEngine.ts,protect.ts}` (re-export API types; + new builder/validator)
- `atlasent-sdk/python/atlasent/models.py` (+ new builder/validator)
- `atlasent-console/packages/types/src/policy.ts` (replace definitions with re-exports of API types)
- `atlasent-console/src/pages/PolicyBuilderPage.tsx` (shorthand→canonical on serialize)
- `atlasent-console/src/pages/ConstraintBuilder.tsx` (deprecation path V1→V3)
- `atlasent-console/src/components/policy/TemplateEditorModal.tsx`
- `atlasent-console/src/hooks/usePolicyBundles.ts`
- `atlasent-console/src/lib/api/rpc-client.ts`
</content>
