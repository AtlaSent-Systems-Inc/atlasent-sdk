# `@atlasent/cursor`

AtlaSent authorization wrapper for Cursor agent tools. Wraps any Cursor
tool's call function with authorize-first semantics:

1. `evaluate` — check the policy engine
2. `verifyPermit` — confirm the permit cryptographically
3. `execute` — run the tool only if both pass

Zero-dependency on Cursor's runtime — operates on plain objects so the
wrapped `execute` plugs into whatever tool registration interface your
Cursor agent uses.

## Install

```bash
npm install @atlasent/cursor @atlasent/sdk
```

## Surface

```ts
import { withCursorGuard } from "@atlasent/cursor";
import { AtlaSentClient } from "@atlasent/sdk";

const atlasent = new AtlaSentClient({ apiKey, baseUrl });

const guarded = withCursorGuard(
  [{
    name: "edit_file",
    description: "Edit a file in the user's workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        new_content: { type: "string" },
      },
      required: ["path", "new_content"],
    },
    execute: async ({ path, new_content }) => writeFile(path, new_content),
  }],
  atlasent,
  { agent: "service:cursor-agent" },
);

// Register `guarded` with the Cursor agent runtime.
```

## Options

| Option         | Type                                              | Description                                                                                           |
| -------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `agent`        | `string \| (name, input) => string`               | Required. Agent identifier (e.g. `"service:cursor-agent"`).                                           |
| `action`       | `string \| (name, input) => string`               | Optional. Action name; defaults to the tool's `name`.                                                 |
| `extraContext` | `object \| (name, input) => object`               | Optional. Extra context forwarded to AtlaSent on every evaluation.                                    |
| `onDeny`       | `"throw"` (default) \| `"tool-result"`            | `"throw"` raises `AtlaSentDeniedError`; `"tool-result"` returns a JSON `DenialResult` for the agent.  |

When the wrapped tool returns a JSON object string, the guard annotates it
with `_atlasent_permit_id` and `_atlasent_audit_hash` so downstream auditors
can verify the call.

## Local development

```bash
cd typescript/packages/cursor
npm install
npm test
npm run typecheck
npm run build
```

## License

MIT — see [`LICENSE`](./LICENSE).
