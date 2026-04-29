# `@atlasent/enforce` (skeleton)

Non-bypassable execution wrapper for the AtlaSent SDK. Forces
`verify-permit` on every gated action and fails closed on any error.

> **Status: skeleton, no implementation.** This package compiles and
> exposes typed surfaces, but `Enforce.run()` throws
> `NotImplementedError`. Implementation lands gated behind
> SIM-01..SIM-10 — see `contract/SIM_SCENARIOS.md`.

Spec: [`contract/ENFORCE_PACK.md`](../../../contract/ENFORCE_PACK.md).

## Surface (planned)

```ts
import { Enforce } from "@atlasent/enforce";

const enforce = new Enforce({
  client,                                   // v1 SDK client
  bindings: { orgId, actorId, actionType }, // permit binding tuple
  failClosed: true,                          // non-toggleable
});

const result = await enforce.run({
  request: { /* CDO inputs */ },
  execute: async (permit) => doTheThing(permit),
});
```

## Why a separate package

The v1 SDK (`@atlasent/sdk`) ships to npm and is locked at GA. Enforce
is a net-new package so we can iterate on the wrapper contract without
any risk of regressing v1 callers.

## Local development

```bash
cd typescript/packages/enforce
npm install
npm test       # smoke tests only until SIM fixtures land
npm run typecheck
npm run build
```
