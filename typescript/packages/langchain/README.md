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
    extraContext: { environment: "production" },
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
| `action`       | `string \| (name, input) => string`               | Optional. Action type; defaults to `"agent.tool.invoke"` (see [Action and context](#action-and-context)). |
| `extraContext` | `object \| (name, input) => object`               | Extra context forwarded to AtlaSent on every evaluation. Must carry `environment` for the default `agent.tool.invoke` action. Cannot override `tool`. |
| `stateSnapshot` | `object \| (name, input) => object`              | Required for most action classes. System state at evaluation time. At minimum: `{ source: "...", complete: true }`. Omitting causes `SNAPSHOT_REQUIRED` denies. |
| `onDeny`       | `"throw"` (default) \| `"tool-result"`            | `"throw"` raises `AtlaSentDeniedError`; `"tool-result"` returns a JSON `DenialResult` for the LLM.    |

When the wrapped tool returns a JSON object string, the guard annotates it
with `_atlasent_permit_id` and `_atlasent_audit_hash` so downstream auditors
can verify the call.

## Action and context

Every guarded call is evaluated as **`agent.tool.invoke`** (Canon ACT-0029,
exported as `DEFAULT_TOOL_ACTION`) unless you pass `action`. That is the
canonical action for an agent invoking a tool. Earlier builds defaulted the
action to the bare tool name (e.g. `"query_database"`), which names no runtime
action class, so every call was denied.

The guard always sends the invoked tool's name (the tool's `name`) as
`context.tool`, alongside `context.tool_input`. `context.tool` is written
after `extraContext` is merged, so `extraContext` cannot relabel a call as a
different tool.

**The `agent.tool.invoke` action class requires two context inputs: `tool`
and `environment`.** The guard supplies `tool`. It does **not** invent an
`environment` — pass it yourself, or the runtime denies the call for a
missing required input:

```ts
{
  agent: "service:analytics-bot",
  extraContext: { environment: "production" },
  stateSnapshot: { source: "my-service", complete: true },
}
```

A string `context.environment` (or `context.environment_name`) is also
forwarded to `verifyPermit` as `environment`.

To keep a per-tool action class of your own, pass `action` (a string, or a
resolver `(name, input) => string`); it is used exactly as before, and must name an
action class that exists in your org.

**Target binding is not applied.** `@atlasent/sdk`'s `evaluate` request has no
top-level `resource_id`, and `verifyPermit` does not present a `target_id`, so
the permit is not bound to the specific tool the way `@atlasent/mcp-server`'s
tool gate binds it. `context.tool` is policy input and audit evidence, not a
verify-time target check.

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
