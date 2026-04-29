# B5 Hand-off — `withPermit` audit in `atlasent-mcp-server` and `atlasent-action`

> **Scope.** B5 in `LAST_20_EXECUTION_PLAN`. This work lives **outside
> this repo** — `atlasent-mcp-server` and `atlasent-action` are
> separate repos. This doc is the checklist whoever picks B5 up needs
> to land that work cleanly.

## What just happened

`withPermit` / `with_permit` / `WithPermit` shipped in the three SDKs:

| Lang | PR | Surface |
|---|---|---|
| TypeScript | #123 | `import { withPermit } from "@atlasent/sdk"` |
| Python | #124 | `from atlasent import with_permit` (sync) + `from atlasent.aio import with_permit` (async) |
| Go | #125 (stacked on #121) | `atlasent.WithPermit[T any](ctx, c, req, fn) (T, error)` |

All three delegate to `protect()` / `Client.Protect`, so callers get a
single fail-closed boundary that:

1. evaluates the request → throws on policy denial
2. verifies the resulting permit → throws on `verified: false`
   (covers v1 single-use replay protection)
3. invokes the wrapped function with the verified permit
4. returns the function's result

## What B5 is

The two adjacent repos currently call `evaluate()` directly to gate
their primary actions, **then assume the permit is good without
calling `verifyPermit()`**. That's a real correctness gap: in v1 a
permit can be revoked between evaluate and execution. The audit:

1. **Find every `evaluate()` call site** in the two repos.
2. For call sites that are immediately followed by an action that
   would benefit from `verifyPermit()` (i.e. anything taking real-world
   effect), replace the evaluate-only pattern with `withPermit()` / the
   language equivalent.
3. **Don't migrate** call sites that are pure preview / dry-run /
   probe (they're allowed to skip the verify hop on purpose).
4. Add a regression test per migrated call site that asserts the
   verify hop fires.

## Repo-by-repo

### `atlasent-mcp-server`

- Likely TypeScript. Use **#123**'s `withPermit(req, fn)`.
- MCP tools that take real-world action (file write, shell exec,
  network call) are the audit candidates.
- Tools that only **read** state and return data to the LLM are
  arguably fine on `evaluate()` alone — flag them but don't
  necessarily migrate.

### `atlasent-action`

- GitHub Action (Node, distributed via npm). Use **#123**.
- The action's `run()` flow currently calls `evaluate` once at start.
  That should become `withPermit` so the run aborts cleanly if the
  permit is revoked between evaluate and the wrapped step.
- Inputs that pin context (commit SHA, env, approver) flow into the
  `context` arg of `withPermit`.

### Bonus: any internal Python services

The Python `with_permit` is sync-by-default (`atlasent.with_permit`)
and async via `atlasent.aio.with_permit`. Internal services using
the sync client get `with_permit`; FastAPI / async-httpx services get
`aio.with_permit`.

## Acceptance criteria

A B5 PR in either repo is "done" when:

- [ ] No `evaluate()` call site in the diff is immediately followed by
      a real-world side-effect without an interceding `verifyPermit()`
      (or a `withPermit` wrapper that covers both).
- [ ] Each migrated call site has a unit test asserting the verify
      step fires (mock the verify endpoint, assert it was called once).
- [ ] At least one migrated call site has a **replay-protection test**
      mirroring the SDK pattern: server returns `verified: false` /
      `outcome: permit_consumed`, the wrapped action MUST NOT execute.
- [ ] CHANGELOG entry: "switch X from `evaluate()` to `withPermit()`
      for v1 single-use replay protection".

## Reference test pattern

From `typescript/test/withPermit.test.ts` (PR #123):

```ts
it("replay → withPermit refuses to invoke fn", async () => {
  // Server returns verified=false, outcome=permit_consumed
  const fetch = scriptedFetch([
    { body: { permitted: true, decision_id: "p", ... } },     // evaluate → ALLOW
    { body: { verified: false, outcome: "permit_consumed" } }, // verify  → CONSUMED
  ]);
  const client = new AtlaSentClient({ apiKey, fetch });

  let ran = false;
  await expect(
    withPermit(client, req, () => { ran = true; }),
  ).rejects.toBeInstanceOf(AtlaSentDeniedError);
  expect(ran).toBe(false);
});
```

## Out of scope

- v2-alpha. The audit applies to v1's `evaluate` / `verifyPermit`
  flow. v2 has its own consume/proof lifecycle (already covered by
  `python/atlasent_v2_alpha/` and `typescript/packages/v2-alpha/`).
- Bypassing `withPermit` for hot-path read traffic. If a downstream
  tool deliberately uses `evaluate()` alone, document why in the
  audit note rather than mechanically swap.
