# SIM-01..SIM-10 Manual Sign-Off Log

Each row records a human reviewer confirming that all ten SIM scenarios
passed in CI **and** the `enforce-no-bypass` lint was green at the
stated release tag. This file is append-only — do not edit existing rows.

## Format

```
<release-tag>  <date>  <reviewer-github-login>  <CI-run-url>
```

`release-tag` follows the pattern `{lang}-enforce-vX.Y.Z` (e.g.
`py-enforce-v1.0.0`, `ts-enforce-v1.0.0`). For a combined release,
list one row per package.

## Sign-offs

<!-- No releases signed off yet. Add a row here when the first
     Enforce Pack release is cut and CI is green. Example:

py-enforce-v1.0.0   2026-05-01   reviewer-login   https://github.com/AtlaSent-Systems-Inc/atlasent-sdk/actions/runs/XXXXXXX
ts-enforce-v1.0.0   2026-05-01   reviewer-login   https://github.com/AtlaSent-Systems-Inc/atlasent-sdk/actions/runs/XXXXXXX
-->
