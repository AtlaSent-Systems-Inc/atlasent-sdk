# `@atlasent/llamaindex`

AtlaSent authorization wrapper for LlamaIndex tools. Wraps any LlamaIndex
tool's call function with authorize-first semantics:

1. `evaluate` — check the policy engine
2. `verifyPermit` — confirm the permit cryptographically
3. `execute` — run the tool only if both pass

Zero-dependency on `llamaindex` — operates on plain objects, so the
wrapped `execute` works with `FunctionTool.from(...)` or any custom
tool definition.

## Install

```bash
npm install @atlasent/llamaindex @atlasent/sdk
```

## Surface

```ts
import { withLlamaIndexGuard } from "@atlasent/llamaindex";
import { AtlaSentClient } from "@atlasent/sdk";
import { FunctionTool } from "llamaindex";

const atlasent = new AtlaSentClient({ apiKey, baseUrl });

const guarded = withLlamaIndexGuard(
  [{
    metadata: {
      name: "query_database",
      description: "Run a read-only SQL query.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
    execute: async ({ query }) => JSON.stringify(await db.query(query)),
  }],
  atlasent,
  { agent: "service:analytics-bot" },
);

const tools = guarded.map((g) =>
  FunctionTool.from(g.execute, g.metadata),
);
```

## Options

| Option         | Type                                              | Description                                                                                           |
| -------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `agent`        | `string \| (name, input) => string`               | Required. Agent identifier (e.g. `"service:analytics-bot"`).                                          |
| `action`       | `string \| (name, input) => string`               | Optional. Action name; defaults to the tool's `metadata.name`.                                        |
| `extraContext` | `object \| (name, input) => object`               | Optional. Extra context forwarded to AtlaSent on every evaluation.                                    |
| `onDeny`       | `"throw"` (default) \| `"tool-result"`            | `"throw"` raises `AtlaSentDeniedError`; `"tool-result"` returns a JSON `DenialResult` for the LLM.    |

When the wrapped tool returns a JSON object string, the guard annotates it
with `_atlasent_permit_id` and `_atlasent_audit_hash` so downstream auditors
can verify the call.

## Local development

```bash
cd typescript/packages/llamaindex
npm install
npm test
npm run typecheck
npm run build
```

## License

Apache-2.0 — see [`LICENSE`](./LICENSE).
