# @atlasent/llamaindex

AtlaSent authorization wrapper for [LlamaIndex](https://www.llamaindex.ai/) tools. Mirrors the `BaseTool` / `FunctionTool` shape with authorize-first semantics: **evaluate → verifyPermit → execute**. Zero dependency on `llamaindex` — duck-typed.

## Installation

```bash
npm install @atlasent/llamaindex @atlasent/sdk
```

## Quick start

```ts
import { AtlaSentClient } from "@atlasent/sdk";
import { FunctionTool } from "llamaindex";
import { withLlamaIndexGuard } from "@atlasent/llamaindex";

const atlasent = new AtlaSentClient({ apiKey: process.env.ATLASENT_API_KEY! });

const guarded = withLlamaIndexGuard(
  [
    {
      metadata: {
        name: "vector_search",
        description: "Semantic search over the knowledge base",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
      execute: async ({ query }) => vectorStore.search(query),
    },
  ],
  atlasent,
  { agent: "service:knowledge-bot" },
);

// Pass directly to FunctionTool or use as BaseTool in AgentRunner
const tools = guarded.map((t) => FunctionTool.from(t.execute, t.metadata));
```

## API

### `withLlamaIndexGuard(tools, client, options)`

| Parameter | Type | Description |
|---|---|---|
| `tools` | `LlamaIndexGuardedTool[]` | Tool definitions with `metadata` and `execute` |
| `client` | `AtlaSentClient` | Initialized AtlaSent client |
| `options.agent` | `string \| Resolver` | Agent identifier or per-call resolver |
| `options.action` | `string \| Resolver` | Action name (defaults to `metadata.name`) |
| `options.extraContext` | `object \| Resolver` | Extra context forwarded to every evaluation |
| `options.onDeny` | `"throw" \| "tool-result"` | Denial behavior (default: `"throw"`) |

Returns the same array with `execute` replaced by an authorize-first version.

**Object results** are annotated with `_atlasent_permit_id` and `_atlasent_audit_hash`. Non-object results pass through unchanged.

**`onDeny: "tool-result"`** returns a `DenialResult` object instead of throwing `AtlaSentDeniedError`.

## License

MIT — see [LICENSE](./LICENSE)
