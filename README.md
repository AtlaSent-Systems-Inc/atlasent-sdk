# AtlaSent SDKs

> **Versioning note (Doctrine 5).** Per-language SDK SemVer is
> **independent** of the AtlaSent platform version. There is one
> platform version — `v1` — and no "v2 product." A
> `@atlasent/sdk@2.x` release is the second major **SDK** contract
> generation (a breaking change in SDK ergonomics, wire-call API,
> or type surface) and is not "AtlaSent v2." Both SDKs target the
> stable `/v1-evaluate` and `/v1-verify-permit` endpoints. See the
> umbrella [Versioning Doctrine](https://github.com/AtlaSent-Systems-Inc/atlasent/blob/main/VERSIONING_DOCTRINE.md)
> (Doctrines 3 and 5) and the precedent set by Stripe, AWS, and
> OpenAI client libraries.

Client SDKs for **AtlaSent execution-time authorization infrastructure** — one runtime gating protected actions across AI agent tool calls, CI/CD deployment, financial close, and any action whose effect leaves the model sandbox.

Fail-closed by design — no protected action proceeds without an explicit, server-verified permit.

> AtlaSent is **not** a feature flag platform. A flag controls
> whether a behavior is enabled; AtlaSent controls whether an action
> is authorized to execute. See
> [Runtime control vs. feature flags](https://github.com/AtlaSent-Systems-Inc/atlasent-docs/blob/main/architecture/runtime-control-vs-feature-flags.md)
> and the
> [Protected actions catalog](https://github.com/AtlaSent-Systems-Inc/atlasent-docs/blob/main/guides/protected-actions-catalog.md).

| Language   | Package           | Install                    | Source                                   |
|------------|-------------------|----------------------------|------------------------------------------|
| Python     | `atlasent`        | `pip install atlasent`     | [`./python/`](./python/)                 |
| TypeScript | `@atlasent/sdk`   | `npm i @atlasent/sdk`      | [`./typescript/`](./typescript/)         |

## 30-second quickstart

### Governing agent tool calls (LangChain / MCP / AI-native)

Wrap any LangChain tool with one decorator to gate every call through AtlaSent:

```python
from atlasent_langchain import with_langchain_guard

@with_langchain_guard(
    agent="agent:research-bot",
    action="agent.search.web",
)
def search_web(query: str) -> str:
    return requests.get(f"https://search.example.com?q={query}").text

# AtlaSent evaluates the action before search_web() runs.
# If denied or held, the function raises AtlaSentDeniedError — the search never executes.
result = search_web("latest SEC filings for ACME Corp")
```

```ts
import { withLangChainGuard } from "@atlasent/guard/langchain";

const guardedTools = withLangChainGuard(
  [searchWebTool, writeDatabaseTool, callExternalApiTool],
  { agent: "agent:research-bot" },
);
// Every tool in guardedTools calls AtlaSent before executing.
// Tools use their name as the action_type by default (e.g. "search_web").
```

### CI/CD deploy gate

```python
from atlasent import protect

permit = protect(
    agent="ci-deploy-bot",
    action="production.deploy",
    context={"repo": "atlasent/api", "commit": commit, "environment": "production"},
    state_snapshot={"source": "github-actions", "complete": True},
)
# If protect() returns, /v1-evaluate allowed and /v1-verify-permit verified.
run_deploy()
```

```ts
import { AtlaSentClient } from "@atlasent/sdk";

const client = new AtlaSentClient({ apiKey: process.env.ATLASENT_API_KEY! });

const gate = await client.deployGate({
  context: { repo: "atlasent/api", commit: process.env.GIT_SHA, environment: "production" },
  stateSnapshot: { source: "github-actions", complete: true },
});

if (!gate.allowed) {
  throw new Error(`Deploy blocked: ${gate.reason}`);
}

runDeploy();
```

All forms perform `evaluate → permit → verify` in one call. The
mutation is unreachable unless the policy allowed the action *and* the
issued permit verified server-side. On any other outcome (`deny`,
`hold`, `escalate`, or any non-verified permit) the SDK raises
`AtlaSentDeniedError` and the mutation never runs. See
[Execution binding](https://github.com/AtlaSent-Systems-Inc/atlasent-docs/blob/main/guides/execution-binding.md).

## LangChain and MCP integration

AtlaSent ships first-class integrations for the two most common AI agent patterns:

### LangChain guard (`@atlasent/guard/langchain` / `atlasent_langchain`)

Wrap any tool array with `withLangChainGuard()` (TypeScript) or decorate individual tool functions with `@with_langchain_guard` (Python). The guard:

- Calls `/v1-evaluate` before every tool invocation.
- Passes the tool name as `action_type` by default; override per-tool with a custom resolver.
- Annotates successful tool results with the `permit_token` for downstream audit.
- On `deny` or `hold`: raises `AtlaSentDeniedError` (throw mode) or returns a structured `DenialResult` (tool-result mode — lets the LLM see the denial reason and respond gracefully).
- Supports `permitRevalidationIntervalMs` for long-running agent loops (continuous authorization heartbeat).

```ts
import { withLangChainGuard } from "@atlasent/guard/langchain";

const tools = withLangChainGuard(
  [webSearchTool, databaseWriteTool, externalApiTool],
  {
    agent: "agent:my-assistant",
    onDeny: "tool-result",         // let the LLM handle denials gracefully
    extraContext: () => ({
      session_id: getCurrentSession(),
    }),
  },
);
```

### MCP server (`@atlasent/mcp-server`)

Install the MCP server to expose AtlaSent tools (`atlasent_evaluate`, `atlasent_verify_permit`) to any MCP-compatible agent host (Claude Desktop, Cursor, Claude Code). The agent calls `evaluate` before every sensitive tool and `verify_permit` afterwards to close the audit loop.

```bash
npx -y @atlasent/mcp-server   # 60-second local demo, no credentials needed
```

See [atlasent-mcp-server](https://github.com/AtlaSent-Systems-Inc/atlasent-mcp-server) for the full demo and integration guide.

## Canonical protected actions

`action_type` is yours to define — any string that names a meaningful operation in your system. The canonical catalog below shows the breadth of what AtlaSent governs out of the box:

| Action | Used for |
|---|---|
| `model.agent.execute_tool` | **Agent tool calls** — any tool invocation whose effect leaves the model sandbox (web search, DB write, external API, code execution). |
| `production.deploy` | Service deploys from CI to production. |
| `vendor.payment.release` | Outbound payments from accounts payable. |
| `customer.data.export` | Exports of customer records out of the system of record. |
| `reconciliation.certify` | Period-end reconciliation certification. |

**AI-native and MCP builders** typically define their own action namespace. Common patterns:

```
agent.search.web            agent.db.write              agent.db.delete
agent.api.post              agent.code.execute          agent.fs.write
agent.email.send            agent.calendar.create       agent.payment.initiate
```

Any `action_type` your policies don't recognize is **denied by default** — fail-closed is the system default.

A runnable example wiring all five catalog actions end to end lives in
[`atlasent-examples/protected-actions-catalog/`](https://github.com/AtlaSent-Systems-Inc/atlasent-examples/tree/main/protected-actions-catalog).

## API endpoints

Both SDKs target the same two endpoints on the `/v1-*` surface:

- `POST https://api.atlasent.io/v1-evaluate`
- `POST https://api.atlasent.io/v1-verify-permit`

Full wire-format parity: a Python permit token is verifiable from the TypeScript SDK and vice-versa.

The `V2_ROLLOUT.md` document in this repo is a **historical filename**
preserved per Doctrine 4. Its substantive content (batch evaluate,
streaming evaluate, GraphQL client, behavior-conditioning helper)
ships as additive Phase 1 / Phase 2 work on the same `/v1/*` wire
surface.

## Repository layout

```
atlasent-sdk/
├── python/         # Python SDK — pip install atlasent
├── typescript/     # TypeScript SDK — npm i @atlasent/sdk
├── contract/       # Shared API contract — schemas, vectors, drift detector
└── .github/
    └── workflows/  # per-language CI, path-filtered
```

## The contract

All SDKs target the same two endpoints and wire shapes. Canonical definitions live in [`contract/`](./contract/).

## Getting an API key

Sign up at [atlasent.io](https://atlasent.io) → Settings → API Keys.

## License

Licensed under the [Apache License, Version 2.0](./LICENSE). See [NOTICE](./NOTICE) for attribution.

Copyright (c) AtlaSent IP Holdings LLC

Commercial licensing inquiries: [legal@atlasent.io](mailto:legal@atlasent.io)

> Note: subpackage manifests under `python/` and `typescript/` may still carry their previous license metadata. Future releases will publish under Apache-2.0; already-published tarballs cannot be retroactively relicensed.
