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

Client SDKs for **AtlaSent execution-time authorization infrastructure** — one runtime gating protected actions across CI/CD deployment, financial close, and AI agent execution.

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

### Python

```python
from atlasent import protect

permit = protect(
    agent="ci-deploy-bot",
    action="production.deploy",
    context={"repo": "atlasent/api", "commit": commit, "environment": "production"},
)
# If protect() returns, /v1-evaluate allowed and /v1-verify-permit verified.
run_deploy()
```

### TypeScript

```ts
import { AtlaSentClient } from "@atlasent/sdk";

const client = new AtlaSentClient({ apiKey: process.env.ATLASENT_API_KEY! });

const gate = await client.deployGate({
  context: { repo: "atlasent/api", commit: process.env.GIT_SHA, environment: "production" },
});

if (!gate.allowed) {
  throw new Error(`Deploy blocked: ${gate.reason}`);
}

runDeploy();
```

Both snippets perform `evaluate → permit → verify` in one call. The
mutation (`run_deploy()` / `runDeploy()`) is unreachable unless the
policy allowed the action *and* the issued permit verified
server-side. On any other outcome (`deny`, `hold`, `escalate`, or any
non-verified permit) the SDK raises `AtlaSentDeniedError` and the
mutation never runs. See
[Execution binding](https://github.com/AtlaSent-Systems-Inc/atlasent-docs/blob/main/guides/execution-binding.md).

## Canonical protected actions

The SDK and examples target this catalog of canonical actions:

| Action | Used for |
|---|---|
| `production.deploy` | Service deploys from CI to production. |
| `vendor.payment.release` | Outbound payments from accounts payable. |
| `customer.data.export` | Exports of customer records out of the system of record. |
| `reconciliation.certify` | Period-end reconciliation certification. |
| `model.agent.execute_tool` | Agent invocations of tools whose effect leaves the model sandbox. |

A runnable example wiring all five end to end lives in
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
