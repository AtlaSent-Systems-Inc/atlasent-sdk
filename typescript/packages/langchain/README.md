# @atlasent/langchain

AtlaSent authorization wrapper for [LangChain](https://www.langchain.com/) tools. Wraps any LangChain tool factory with authorize-first semantics: **evaluate → verifyPermit → execute**. Only the real tool runs when both checks pass.

## Installation

```bash
npm install @atlasent/langchain @atlasent/sdk
```

## Quick start

```ts
import { AtlaSentClient } from "@atlasent/sdk";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { withLangChainGuard } from "@atlasent/langchain";
import { z } from "zod";

const atlasent = new AtlaSentClient({ apiKey: process.env.ATLASENT_API_KEY! });

const defs = withLangChainGuard(
  [
    {
      name: "query_database",
      description: "Run a read-only SQL query",
      execute: async ({ sql }) => JSON.stringify(await db.query(sql)),
    },
  ],
  atlasent,
  { agent: "service:analytics-bot" },
);

// Pass to any LangChain tool factory
const tools = defs.map((d) =>
  new DynamicStructuredTool({
    name: d.name,
    description: d.description,
    schema: z.object({ sql: z.string() }),
    func: d.execute,
  }),
);
```

## API

### `withLangChainGuard(tools, client, options)`

| Parameter | Type | Description |
|---|---|---|
| `tools` | `LangChainGuardedTool[]` | Tool definitions with `name`, `description`, and `execute` |
| `client` | `AtlaSentClient` | Initialized AtlaSent client |
| `options.agent` | `string \| Resolver` | Agent identifier or per-call resolver |
| `options.action` | `string \| Resolver` | Action name (defaults to tool name) |
| `options.extraContext` | `object \| Resolver` | Extra context forwarded to every evaluation |
| `options.onDeny` | `"throw" \| "tool-result"` | Denial behavior (default: `"throw"`) |

Returns the same array with `execute` replaced by an authorize-first version.

**JSON object results** are annotated with `_atlasent_permit_id` and `_atlasent_audit_hash`. Plain-text results pass through unchanged.

**`onDeny: "tool-result"`** returns a JSON `DenialResult` string instead of throwing `AtlaSentDeniedError`, so the LLM can observe the reason and adapt.

## License

MIT — see [LICENSE](./LICENSE)
