# `@atlasent/langchain`

[![npm](https://img.shields.io/npm/v/@atlasent/langchain.svg)](https://www.npmjs.com/package/@atlasent/langchain)

AtlaSent authorization wrapper (guardrails / AI agent gating) for LangChain
tools. Wraps any LangChain tool's `execute` callback with authorize-first
semantics:

1. `evaluate` — check the policy engine
2. `verifyPermit` — confirm the permit cryptographically
3. `execute` — run the tool only if both pass

Zero-dependency on `@langchain/core` — operates on plain objects, so the
wrapped `execute` works with `DynamicStructuredTool`, `DynamicTool`, or any
custom Tool subclass.

## Install

```bash
npm install @atlasent/langchain @atlasent/sdk
```

## Surface

```ts
import { withLangChainGuard } from "@atlasent/langchain";
import { AtlaSentClient } from "@atlasent/sdk";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

const atlasent = new AtlaSentClient({ apiKey, baseUrl });

const guarded = withLangChainGuard(
  [{
    name: "query_database",
    description: "Run a read-only SQL query.",
    execute: async ({ query }) => JSON.stringify(await db.query(query)),
  }],
  atlasent,
  {
    agent: "service:analytics-bot",
    stateSnapshot: { source: "my-service", complete: true },
  },
);

const tools = guarded.map((d) =>
  new DynamicStructuredTool({
    name: d.name,
    description: d.description,
    schema: z.object({ query: z.string() }),
    func: d.execute,
  }),
);
```

## Options

| Option         | Type                                              | Description                                                                                           |
| -------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `agent`        | `string \| (name, input) => string`               | Required. Agent identifier (e.g. `"service:analytics-bot"`).                                          |
| `action`       | `string \| (name, input) => string`               | Optional. Action name; defaults to the tool's `name`.                                                 |
| `extraContext` | `object \| (name, input) => object`               | Optional. Extra context forwarded to AtlaSent on every evaluation.                                    |
| `stateSnapshot` | `object \| (name, input) => object`              | Required for most action classes. System state at evaluation time. At minimum: `{ source: "...", complete: true }`. Omitting causes `SNAPSHOT_REQUIRED` denies. |
| `onDeny`       | `"throw"` (default) \| `"tool-result"`            | `"throw"` raises `AtlaSentDeniedError`; `"tool-result"` returns a JSON `DenialResult` for the LLM.    |

When the wrapped tool returns a JSON object string, the guard annotates it
with `_atlasent_permit_id` and `_atlasent_audit_hash` so downstream auditors
can verify the call.

## Local development

```bash
cd typescript/packages/langchain
npm install
npm test
npm run typecheck
npm run build
```

## License

Apache-2.0 — see [`LICENSE`](./LICENSE).
