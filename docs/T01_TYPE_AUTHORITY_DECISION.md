# T-01 type authority decision

**Status:** ACCEPTED
**Accepted:** 2026-08-22
**Related:** `docs/T01_TYPE_AUTHORITY_DECISION_PACKAGE.md`, atlasent#345/#349/#350

## Decision

`@atlasent/types` is the canonical source for **shared AtlaSent wire-contract types**. `@atlasent/sdk` remains the customer-facing SDK contract and may re-export, alias, or adapt canonical wire types while preserving the existing SDK import surface.

The success condition is **not** "delete `typescript/src/types.ts` at all costs." The success condition is:

> No shared wire-contract type is independently defined in the SDK.

SDK-specific abstractions may remain SDK-owned when they describe SDK ergonomics rather than the HTTP wire protocol, provided their mapping to canonical wire types is explicit and tested.

## Ownership boundary

### `@atlasent/types` owns

- exact shared HTTP request/response shapes;
- shared wire enums and unions;
- canonical authorization/evidence structures used across runtime, SDK, console, and external TypeScript services;
- type-only definitions that multiple AtlaSent components must agree on field-for-field.

### `@atlasent/sdk` owns

- SDK method options and ergonomic facades;
- compatibility aliases/adapters for existing public SDK contracts;
- runtime classes and errors;
- SDK-specific convenience/domain types that are not the canonical wire representation;
- normalization between legacy/ergonomic SDK shapes and canonical wire shapes.

A canonical wire type may have one authoritative definition. An SDK abstraction may have a distinct type only when it is intentionally a different abstraction, not a hand-copied second definition of the same wire contract.

## Public import stability

Ordinary SDK users remain on `@atlasent/sdk`.

Existing public names should continue to be exported from `@atlasent/sdk` wherever compatibility can be preserved. Consumers are not required to migrate routine SDK imports to `@atlasent/types` merely because the SDK changes its internal source of type authority.

Where a current SDK name is structurally identical to a canonical type, prefer a direct re-export or type alias. Where it differs intentionally, keep an explicit adapter/compatibility contract rather than silently changing the public declaration.

## Runtime values

`@atlasent/types` remains zero-runtime. Runtime constants/values currently exported by the SDK are not moved into the types package merely to make the migration numerically complete.

A small SDK compatibility/re-export module may remain after T-01 if it is useful. File deletion is cleanup, not architecture.

## Package location

The canonical package remains `atlasent-api/packages/types`.

A separate `atlasent-types` repository is not required. Independent package versioning/release cadence is already achievable with the `types-v*` publication workflow while keeping the wire definitions next to the runtime that implements the contract.

## Dependency policy

After first publication, `@atlasent/sdk` should consume `@atlasent/types` as a **regular dependency**, not a peer dependency.

While `@atlasent/types` is pre-1.0, the SDK pins an exact version (for example `0.2.0`) rather than a caret range. Publishing a new types package version must not silently alter the declaration surface of an already-released SDK version.

A looser semver range may be reconsidered after the types package reaches a proven 1.0 contract and normal compatibility guarantees are established.

## First-publication gate

`@atlasent/types` has not yet been proven as a public npm dependency. Before the SDK migration depends on it, the first publication is isolated and verified independently.

Before first publish:

- audit exported declarations against the current runtime wire contract;
- correct stale README/examples and claims about current SDK re-export behavior;
- verify package metadata/exports and zero-runtime behavior;
- verify the edge-function mirror sync check;
- run typecheck/build;
- publish through the existing `package.release`-gated `types-v*` workflow;
- install the released package from a clean external consumer and prove declaration resolution/provenance.

First publication does not itself authorize the SDK migration.

## Migration sequence

1. Freeze this ownership boundary.
2. Audit and publish `@atlasent/types` independently.
3. Produce a complete mapping ledger for the SDK's currently published root type/value surface:
   - exact canonical re-export;
   - compatible alias;
   - legitimate SDK-only abstraction;
   - incompatible shape requiring adapter/deprecation/breaking treatment.
4. Extend drift protection to the shared wire surface rather than relying on hand-copied local schemas alone.
5. Add the exact published `@atlasent/types` version as a regular SDK dependency.
6. Migrate exact/compatible types first while preserving `@atlasent/sdk` names.
7. Golden-diff generated `dist/index.d.ts` before/after; a non-breaking source migration must not silently change the public declaration contract.
8. Compile/test real downstream consumers, especially production consumers in `atlasent-api`, before release.
9. Handle incompatible remainder deliberately with adapters/deprecation and a major SDK release only when unavoidable.
10. Delete/rename legacy local type files only after no independent wire definitions remain.

## Invariants

1. One authoritative definition for every shared wire-contract type.
2. No forced customer import migration from `@atlasent/sdk` for ordinary SDK usage.
3. SDK-specific abstractions remain SDK-owned and map explicitly to wire types.
4. `@atlasent/types` remains zero-runtime.
5. Runtime values are not moved into the types package merely for migration completeness.
6. `@atlasent/types` is a regular dependency of the SDK once consumed.
7. Exact pinning while the types package is 0.x.
8. SDK release N's declaration surface cannot change because `@atlasent/types` N+1 was published.
9. First types publication is proven independently before SDK migration relies on it.
10. A type-source refactor cannot silently change generated `.d.ts` output.
11. Cross-repo consumers must compile against the candidate SDK before a compatible release claim is made.
12. Package documentation/examples are part of the public contract and must match the real wire.
13. "Delete `types.ts`" is not a success metric; eliminating independent wire-type definitions is.

## Rejected alternatives

- Making every SDK type canonical in `@atlasent/types` regardless of whether it is wire-level or SDK-specific.
- Forcing customers to import routine SDK contract names directly from `@atlasent/types`.
- Using a peer dependency for a type package that is part of the SDK's own emitted declaration implementation.
- Floating a pre-1.0 types dependency under a permissive range.
- Publishing the types package and immediately stacking an SDK migration on an unproven release pipeline without an isolated proof step.
- Creating a separate repository solely to obtain independent package releases.

This decision ratifies the direction identified by the T-01 decision package while narrowing its scope to the actual architecture problem: wire-contract authority, not indiscriminate type centralization.
