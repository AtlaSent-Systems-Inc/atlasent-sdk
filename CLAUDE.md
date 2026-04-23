# CLAUDE.md

Project-level instructions for Claude Code working on `atlasent-sdk`.

## Auto-open PRs when work reaches a natural stopping point

When a feature branch's work is **complete** (code committed, pushed to
origin, tests + lint + typecheck all green), proactively open a pull
request for it without waiting for an explicit "do PR" instruction.

A branch is "complete" when all of the following are true:
- The branch's intended scope is fully implemented.
- Every change is committed and pushed to `origin/<branch>`.
- All relevant checks pass locally (`pytest` for Python, `npm test` +
  `npm run typecheck` + `npm run build` for TypeScript, contract suite
  if contract files touched).
- A CHANGELOG entry has been added where appropriate, and version
  bumps are consistent across `_version.py` / `package.json` /
  CHANGELOG.

PR conventions:
- **Base branch**: `main` for standalone work; **the parent branch**
  for stacked work so reviewers see only the incremental diff
  (GitHub auto-updates the base to `main` once the parent merges).
- **Title**: under 70 characters, conventional-commit-style prefix
  (`feat(scope):`, `chore:`, `docs:`, `test:`, `fix:`). Use the
  first line of the head commit as a starting point.
- **Body**: Summary + Test plan sections. For stacked PRs, call out
  the dependency explicitly ("Stacked on PR #N — merge that first").
  For PRs bumping a shared version (e.g., Python `_version.py`) that
  may conflict with parallel branches, note the rebase ceremony.
- **End with the `session_...` footer** the Bash tooling rules
  already specify for `git commit` and `gh pr create` examples.
- **Do not open draft PRs** unless the user asks — the work shipped
  is ready for review.

At natural stopping points — a "stop", "wrap up", "done", "that's it",
or a user acknowledgment that the feature is finished — offer a short
summary of the opened PRs (numbers + titles + stacking relationship)
and stop. Don't keep proposing additional work unless asked.

Exceptions:
- If a branch has unresolved test failures, lint errors, or merge
  conflicts with its intended base, say so and ask before opening.
- If the commit is clearly a WIP (explicit `wip:` prefix,
  half-finished code), don't open the PR.
- If the user has asked to keep the branch local / private, respect
  that for the rest of the session.

## Branch naming

Follow the existing convention in this repo (`contract/SDK_COMPATIBILITY.md`
and recent history): `claude/<lang>-sdk-<topic>` for SDK-scoped work
(e.g., `claude/py-sdk-protect`, `claude/ts-sdk-hono-guard`), or
`claude/<topic>` for cross-cutting work (e.g.,
`claude/finish-work-...`, `claude/sdk-readme-protect-first`).

## Stacking

When a branch depends on another in-flight branch, cut it off the
parent (not off `main`). Open the PR with `base: <parent-branch>`.
Note the dependency in the PR body. This keeps reviewers' incremental
diffs honest and lets each PR merge cleanly once its base is in.

## Contract-first for wire changes

Anything that touches `/v1-evaluate` or `/v1-verify-permit` shapes
goes through `contract/schemas/` first. The SDK drift detector
(`contract/tools/drift.py`) catches drift from there. Do not invent
new endpoints, streaming formats, or bundle formats in the SDK
without a schema or a proposal in `contract/` first — see
`contract/README.md`'s "Adding / changing the contract" section.

## Coverage floors

- TypeScript: `vitest.config.ts` thresholds — keep lines ≥ 95%.
- Python: `pyproject.toml` `[tool.coverage.report] fail_under = 95`.
  Raise as new tests land; don't lower to paper over regressions.
