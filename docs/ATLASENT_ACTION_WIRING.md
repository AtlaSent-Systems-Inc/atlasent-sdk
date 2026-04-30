# `atlasent-action` wiring — Alpha enforce-only path

> Drop-in spec for migrating `atlasent-action` (the GitHub Action) from
> inline evaluate/verify calls to `@atlasent/enforce`. This doc lives
> in `atlasent-sdk` because the SDK side of the contract is here; the
> action repo just consumes it.
>
> Aligned with **A1–A5** of the Phase 6 PR Plan. Closes:
>
> - **A1** — `@atlasent/enforce` ships the wrapper.
> - **A2** — `Enforce.run()` does evaluate → verify → binding-check → execute.
> - **A3** — SIM-04 (replay) + SIM-09 (concurrent consume) cover atomic
>   consumption.
> - **A4** — `scripts/enforce-no-bypass.mjs` rejects direct `.evaluate(`
>   call sites in source. Wire that into the action's CI.
> - **A5** — this doc.

## Done = all of:

1. `@atlasent/enforce` is used in `atlasent-action`.
2. No inline HTTP / decision logic remains in `atlasent-action/src/`.
3. Execution is impossible without verify-permit (the action's runtime
   path goes through `Enforce.run()`).
4. Fail-closed behavior confirmed in tests.
5. SIM-01 (no-permit deny), SIM-04 (replay), SIM-07 (tampered),
   SIM-06 (latency race), SIM-09 (concurrent consume) all green
   against the action's exec path.
6. Action tag `v0.1.0-alpha`.

## Migration shape

### Before (inline)

```ts
// atlasent-action/src/index.ts (current, pre-enforce)
const evalRes = await client.evaluate({ agent, action, context });
if (evalRes.decision !== "allow") {
  core.setFailed(`policy ${evalRes.decision}`);
  return;
}
const permit = await client.verifyPermit(evalRes.permit.token);
// ... call deploy
```

This pattern is what A4 (zero-bypass) is designed to forbid: the call
site can short-circuit after `evaluate` without verifying, or skip
`verifyPermit` entirely on a hot path. Static lint catches none of
the runtime branches.

### After (`Enforce.run()`)

```ts
// atlasent-action/src/index.ts (post-migration)
import { Enforce } from "@atlasent/enforce";
import { AtlaSentClient } from "@atlasent/sdk";
import * as core from "@actions/core";

async function main(): Promise<void> {
  const apiKey = core.getInput("atlasent-api-key", { required: true });
  const orgId = core.getInput("org-id", { required: true });
  const actorId = core.getInput("actor-id") || process.env.GITHUB_ACTOR || "github-actions";
  const actionType = core.getInput("action-type") || "deploy";

  const client = new AtlaSentClient({ apiKey });

  const enforce = new Enforce({
    client,
    bindings: { orgId, actorId, actionType },
    failClosed: true, // non-toggleable — see contract/ENFORCE_PACK.md
    latencyBudgetMs: 1500, // verify within 1.5s or fail closed
    latencyBreachMode: "deny",
  });

  const result = await enforce.run({
    request: {
      agent: actorId,
      action: actionType,
      context: {
        repository: process.env.GITHUB_REPOSITORY,
        ref: process.env.GITHUB_REF,
        sha: process.env.GITHUB_SHA,
      },
    },
    execute: async (permit) => {
      // The wrapped action body. Only runs after evaluate→verify→binding-check.
      // `permit` is the verified Permit; bind audit logs to permit.token.
      core.info(`atlasent permit verified: ${permit.token}`);
      core.setOutput("permit-token", permit.token);
      core.setOutput("expires-at", permit.expiresAt);

      // The actual deploy / step the action wraps.
      // Whatever the action did between the original evaluate and the
      // end of the run goes here. Example:
      //
      //   await runDeployStep(...);
      //   return { deployId: "..." };
      return undefined;
    },
  });

  if (result.decision !== "allow") {
    core.setFailed(`atlasent ${result.decision}: ${result.reasonCode}`);
    return;
  }
}

main().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
```

## Required atlasent-action changes

### 1. `package.json`

```jsonc
{
  "dependencies": {
    "@atlasent/enforce": "^0.1.0-alpha.0",
    "@atlasent/sdk": "^1.5.0",
    "@actions/core": "^1.10.0"
  }
}
```

The action distributes a bundled `dist/` (typical for GitHub Actions),
so `@atlasent/enforce` lands in the bundle output produced by `ncc` /
`esbuild` and ships with the action tarball. No registry pull at
runtime.

### 2. CI gate — wire bypass-lint

Add a workflow step that runs the bypass linter against the action's
source. Drop into `atlasent-action/.github/workflows/ci.yml`:

```yaml
- name: enforce-no-bypass lint
  run: |
    npm install --no-save @atlasent/enforce
    node node_modules/@atlasent/enforce/scripts/enforce-no-bypass.mjs \
      "src/**/*.ts"
```

Or, if the script isn't shipped in the package's `files` list yet,
inline-copy `scripts/enforce-no-bypass.mjs` from `atlasent-sdk` into
`atlasent-action/scripts/`. (Future improvement: ship the script as a
binary from `@atlasent/enforce`'s `bin` field.)

### 3. Test path — port SIM scenarios

`atlasent-action` should exercise the wired action end-to-end against
the same SIM scenarios. The minimum five from the Done criteria:

| SIM | What it asserts in the action |
|---|---|
| SIM-01 (no-permit deny) | Action `core.setFailed`s when `evaluate` returns `decision != "allow"`. Body never runs. |
| SIM-04 (replay attempt) | A reused permit from a prior run fails `verifyPermit` → action fails closed; no execute. |
| SIM-06 (latency race) | If `verifyPermit` latency > `latencyBudgetMs`, action denies under `mode: "deny"`. |
| SIM-07 (tampered permit) | Evaluate returns a tampered permit token; verify rejects; action fails. |
| SIM-09 (concurrent consume) | Two parallel jobs sharing a permit token: only one passes verify; the other fails closed. |

The shared SIM fixtures live at `contract/scenarios/SIM-*.json` in
`atlasent-sdk`. Pull them into `atlasent-action` either via a git
submodule or by vendoring the JSON files. The harness in
`typescript/packages/enforce/test/sim/harness.ts` is the reference
loader.

### 4. Tag

Once the four above land green:

```bash
cd atlasent-action
npm version 0.1.0-alpha.0
git push origin main
git tag v0.1.0-alpha
git push origin v0.1.0-alpha
```

## Hand-off notes for whoever picks this up

- `@atlasent/enforce` lives in `atlasent-sdk/typescript/packages/enforce`.
  Source of truth for the `Enforce` class API.
- Bypass-lint script: `atlasent-sdk/scripts/enforce-no-bypass.mjs`.
- SIM scenarios: `atlasent-sdk/contract/scenarios/SIM-{01..10}.{json,md}`.
- SIM titles vs. Done-criteria mapping (the "five named SIMs" in the
  ledger don't all match the file numbering one-to-one):
  - `bypass` → SIM-10 (Wrapper-bypass attempt)
  - `tampered` → SIM-07
  - `replay` → SIM-04
  - `race` → SIM-06
  - `shadow detection` → SIM-09
  - The ledger's "SIM-01/03/05/06/09" set covers all five concept
    classes via different framings (no-permit / binding-mismatch /
    5xx-fail-closed / latency-race / concurrent-consume). Either
    coverage set satisfies the spirit of the fail-closed-everywhere
    invariant.

## Why my SDK-side scope can't push this

This artifact lives in `atlasent-sdk` because my GitHub MCP scope is
configured to `atlasent-systems-inc/atlasent-sdk` only. I have no
write access to `atlasent-systems-inc/atlasent-action`. Whoever
finishes A5 should:

1. Copy the "After" code block above into `atlasent-action/src/index.ts`.
2. Add the dependencies and CI step from §1–2.
3. Vendor or submodule the SIM fixtures per §3.
4. Tag per §4.
