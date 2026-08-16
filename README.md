# AtlaSent SDKs

Client SDKs for **execution-time authorization**: ask whether a consequential
action is authorized before it executes, receive a scoped permit when allowed,
and verify that permit at the execution boundary.

AtlaSent is designed for actions whose effects leave the model or application
sandbox — deployments, external communications, data changes, financial
operations, regulated actions, and AI-agent tool calls.

```text
attempted action
      │
      ▼
   evaluate
      │
 allow? ── no ──► do not execute
      │ yes
      ▼
 scoped permit
      │
      ▼
 verify permit
      │
      ▼
 execute protected action
```

## Packages

| Language | Package | Install |
|---|---|---|
| Python | `atlasent` | `pip install atlasent` |
| TypeScript | `@atlasent/sdk` | `npm install @atlasent/sdk` |

The language SDKs have their own SemVer release numbers. Those numbers do **not**
rename the platform API. Both clients target the stable AtlaSent `/v1-*`
authorization surface.

## Python quick start

```python
import os
from atlasent import AtlaSentClient

client = AtlaSentClient(api_key=os.environ["ATLASENT_API_KEY"])

# protect() performs the authorization/permit verification path before returning.
permit = client.protect(
    agent="ci-deploy-bot",
    action="production.deploy",
    context={
        "repo": "acme/payments-api",
        "commit": os.environ["GIT_SHA"],
        "environment": "production",
    },
    state_snapshot={
        "source": "github-actions",
        "complete": True,
    },
)

# Reached only after the protected action's authorization path succeeded.
run_deploy()
```

## TypeScript quick start

```ts
import { AtlaSentClient } from "@atlasent/sdk";

const client = new AtlaSentClient({
  apiKey: process.env.ATLASENT_API_KEY!,
});

const gate = await client.deployGate({
  context: {
    repo: "acme/payments-api",
    commit: process.env.GIT_SHA,
    environment: "production",
  },
  stateSnapshot: {
    source: "github-actions",
    complete: true,
  },
});

if (!gate.allowed) {
  throw new Error(`Deploy blocked: ${gate.reason}`);
}

runDeploy();
```

The critical integration rule is simple: **the side effect must be unreachable
unless the required authorization and permit-verification checks succeeded.**
Do not treat an `allow` string by itself as equivalent to execution-boundary
verification when the selected SDK path requires a permit check.

## AI agents and MCP

Agent governance uses the same contract. A database write, external API call,
code execution, file mutation, payment initiation, or other sensitive tool call
can be represented as an `action_type` and evaluated before the tool runs.

Typical application-defined names include:

```text
agent.db.write
agent.db.delete
agent.api.post
agent.code.execute
agent.fs.write
agent.email.send
agent.payment.initiate
```

For MCP-compatible hosts, use the public
[`atlasent-mcp-server`](https://github.com/AtlaSent-Systems-Inc/atlasent-mcp-server).
It demonstrates the authorize-before-execute interception pattern and can run a
local demo without AtlaSent credentials.

## GitHub Actions

For CI/CD enforcement, use the public
[`atlasent-action`](https://github.com/AtlaSent-Systems-Inc/atlasent-action).
The Action derives GitHub execution facts, evaluates the protected action, and
can verify a permit immediately before the deployment or other consequential CI
step.

## Wire contract

Canonical request/response schemas and compatibility fixtures live in
[`contract/`](./contract/). The contract is shared by the Python and TypeScript
clients so a permit produced through one language uses the same runtime wire
semantics as the other.

Primary authorization endpoints:

```text
POST /v1-evaluate
POST /v1-verify-permit
```

Additional SDK features may use additive `/v1-*` endpoints, but SDK major
versions do not imply a separate "AtlaSent v2" product or a replacement control
plane.

## Permits

A permit is the execution artifact produced by successful authorization. The SDK
does not re-derive organizational authority locally; the runtime is the decision
authority.

Permits are scoped and time-bounded. Where single-use verification applies, the
runtime records consumption so replay can be refused. Execution bindings can
also constrain the permit to the artifact, target, environment, or other
verified context expected at the execution boundary.

A human approval is one possible source of authority. Policy rules, deployment
gates, signed external assertions, and other approved authority sources can feed
the same authorization model. The protected action should depend on the permit,
not on each integration re-implementing those authority rules itself.

## Fail-closed integration

For protected actions, treat these as block conditions rather than silent
successes:

- `deny`, `hold`, or `escalate` when execution requires `allow`;
- missing permit when a permit is required;
- failed, expired, revoked, replayed, or mismatched permit;
- missing required execution binding;
- authentication failure;
- authority-service failure on a path configured to require live authorization.

A caller may choose separate advisory or shadow workflows for observation, but
those modes should not be described as enforced execution protection.

## Independent evidence verification

The public
[`atlasent-verify`](https://github.com/AtlaSent-Systems-Inc/atlasent-verify)
repository contains the standalone offline audit-chain verifier and its public
canonical-form contract. Public verifier keys, revocations, and trust-root
material are published in
[`atlasent-keys`](https://github.com/AtlaSent-Systems-Inc/atlasent-keys).

Those repositories are intentionally public so a customer or auditor can inspect
the verification path without access to AtlaSent private infrastructure.

## Repository layout

```text
atlasent-sdk/
├── python/         # Python SDK
├── typescript/     # TypeScript SDK
├── contract/       # shared wire schemas, vectors, and drift checks
├── docs/           # SDK-facing documentation
└── .github/        # CI and release workflows
```

## Development

Python:

```bash
cd python
python -m pytest tests/
```

TypeScript:

```bash
cd typescript
npm ci
npm run typecheck
npm test
npm run build
```

Use the repository's pinned CI and package-manager configuration as the
authoritative release check.

## Security

Do not place API keys, private signing material, customer secrets, or production
credentials in source control. Applications should load AtlaSent credentials
from their platform's secret store and keep authorization context limited to the
facts the selected policy actually needs.

Security-sensitive integration code should keep the protected side effect after
the authorization boundary in control flow — not merely log a decision and
continue regardless of the result.

## Public ecosystem

- [`atlasent-action`](https://github.com/AtlaSent-Systems-Inc/atlasent-action) — GitHub Actions execution gate
- [`atlasent-mcp-server`](https://github.com/AtlaSent-Systems-Inc/atlasent-mcp-server) — MCP authorize-before-execute integration
- [`atlasent-verify`](https://github.com/AtlaSent-Systems-Inc/atlasent-verify) — independent offline audit verifier
- [`atlasent-keys`](https://github.com/AtlaSent-Systems-Inc/atlasent-keys) — public verification material

## License

Licensed under the [Apache License, Version 2.0](./LICENSE). See
[`NOTICE`](./NOTICE) for attribution.

Copyright (c) AtlaSent IP Holdings LLC
