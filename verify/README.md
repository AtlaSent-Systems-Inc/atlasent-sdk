# `@atlasent/verify` and `atlasent-verify`

Standalone offline verifier for AtlaSent's signed audit-export
bundles. Carved out of the main SDK so a customer's auditor can
verify a bundle without installing the full SDK (and its HTTP-client
dependencies).

## Why a separate package?

The full SDKs (`@atlasent/sdk`, `atlasent`) include HTTP clients,
retry logic, observability hooks, and a contract drift detector. An
auditor only needs the cryptographic verifier. Carving it out means:

- **No network code** ships in the auditor's dependency tree.
- **Smaller attack surface** for security teams that need to vet
  every dependency before installation.
- **Compatible across SDK versions** — the verifier follows the
  bundle wire format, not the SDK release cadence.

## Status

This is a scaffold. The TypeScript and Python entrypoints currently
re-export the verifier from the main SDK; the long-term plan is to
relocate the verifier source here and have the main SDK re-export
from this package, so there is exactly one copy of the verifier
code in the repository.

The Go module under `../go/` is also scaffolded in this directory's
sibling.

## Layout

```
verify/
├── typescript/         @atlasent/verify
│   ├── package.json
│   ├── tsconfig.json
│   └── src/index.ts
└── python/             atlasent-verify on PyPI
    ├── pyproject.toml
    └── atlasent_verify/__init__.py
```

## Source-of-truth

Until the relocation lands, the canonical verifier source is:
- TS: `../typescript/src/auditBundle.ts`
- Python: `../python/atlasent/audit_bundle.py`

Both are byte-aligned with the reference verifier in
`atlasent-api/supabase/functions/v1-audit/verify.ts`. The contract
drift detector at `../contract/tools/drift.py` enforces that.
