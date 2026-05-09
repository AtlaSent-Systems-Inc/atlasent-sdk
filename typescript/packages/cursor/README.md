# @atlasent/cursor

AtlaSent authorization wrapper for [Cursor](https://www.cursor.com/) agent tools. Works with the MCP (Model Context Protocol) wire format: **evaluate → verifyPermit → execute** before each tool call. Zero dependency on any Cursor or MCP SDK — duck-typed.

## Installation

```bash
npm install @atlasent/cursor @atlasent/sdk
```

## Quick start

```ts
import { AtlaSentClient } from "@atlasent/sdk";
import { withCursorGuard } from "@atlasent/cursor";

const atlasent = new AtlaSentClient({ apiKey: process.env.ATLASENT_API_KEY! });

const guardedTools = withCursorGuard(
  [
    {
      name: "edit_file",
      description: "Apply a unified diff patch to a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          patch: { type: "string" },
        },
        required: ["path", "patch"],
      },
      execute: async ({ path, patch }) => applyPatch(path, patch),
    },
  ],
  atlasent,
  { agent: "cursor:my-project" },
);

// In your MCP server's CallToolRequestSchema handler:
const tool = guardedTools.find((t) => t.name === request.params.name);
const result = await tool.execute(request.params.arguments ?? {});
return { content: [{ type: "text", text: result }] };
```

## API

### `withCursorGuard(tools, client, options)`

| Parameter | Type | Description |
|---|---|---|
| `tools` | `CursorGuardedTool[]` | Tool definitions with `name`, `description`, optional `parameters`, and `execute` |
| `client` | `AtlaSentClient` | Initialized AtlaSent client |
| `options.agent` | `string \| Resolver` | Agent identifier or per-call resolver |
| `options.action` | `string \| Resolver` | Action name (defaults to tool name) |
| `options.extraContext` | `object \| Resolver` | Extra context forwarded to every evaluation |
| `options.onDeny` | `"throw" \| "tool-result"` | Denial behavior (default: `"throw"`) |

Returns the same array with `execute` replaced by an authorize-first version. Drop-in for your MCP server's `ListToolsResult` / `CallToolResult` handlers.

**JSON object string results** are annotated with `_atlasent_permit_id` and `_atlasent_audit_hash`. Plain-text results (diffs, shell output) pass through unchanged.

**`onDeny: "tool-result"`** returns a JSON-serialized `DenialResult` string instead of throwing `AtlaSentDeniedError`, so Cursor's agent can observe the reason and adapt.

## License

MIT — see [LICENSE](./LICENSE)
