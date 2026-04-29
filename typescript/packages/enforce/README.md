# `@atlasent/enforce`

Non-bypassable execution wrapper for the AtlaSent SDK. Forces
`verify-permit` on every gated action and fails closed on any error.

Spec: [`contract/ENFORCE_PACK.md`](../../../contract/ENFORCE_PACK.md).  
Gate: [`contract/SIM_SCENARIOS.md`](../../../contract/SIM_SCENARIOS.md) — SIM-01..SIM-10 must pass before any Preview-pack code merges.

## Surface

```ts
import { Enforce } from "@atlasent/enforce";
import { AtlasentClient } from "@atlasent/sdk"; // v1

const enforce = new Enforce({
  client: new AtlasentClient({ apiKey, baseUrl }),
  bindings: { orgId, actorId, actionType },
  failClosed: true, // non-toggleable
});

const result = await enforce.run({
  request: { /* CDO inputs */ },
  execute: async (permit) => doTheThing(permit),
});
```

## Local development

```bash
cd typescript/packages/enforce
npm install
npm test
npm run typecheck
npm run build
```
