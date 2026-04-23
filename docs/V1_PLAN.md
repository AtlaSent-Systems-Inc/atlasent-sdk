# atlasent-sdk — V1 Plan

**Role:** canonical SDKs (Python + TypeScript) used by customers to call
the AtlaSent API from their code. One repo, two languages, one wire
contract.

**ICP this round:** an engineer at a biotech who needs to wire an AI
agent through `evaluate` → `verify-permit` in under 5 minutes against
a pilot API key.

---

## Context

- Monorepo: `python/`, `typescript/`, `contract/` (shared schemas,
  vectors, drift detector).
- SDKs target `api.atlasent.io/v1-evaluate` and `v1-verify-permit`.
- Both SDKs claim wire-format parity: Python-issued permit verifiable
  from TS, and vice versa.
- Publishing: Python to PyPI as `atlasent`; TypeScript to npm as
  `@atlasent/sdk`.

---

## V1 gates

### Surface parity

- [ ] Every endpoint in `atlasent-api`'s V1 matrix is reachable from
      both SDKs: `evaluate`, `verify-permit`, `session`, `audit/events`,
      `audit/exports`, `audit/verify`, `approvals`, `overrides`,
      `permits/consume`, `permits/revoke`.
      *Current: only `evaluate` and `verify-permit` are wired. The
      remaining endpoints are queued for follow-up minor bumps.*
- [ ] Streaming `evaluate` endpoint exposed as an async iterator
      (Python `async for`, TS `AsyncIterable`).
- [ ] Offline audit verifier: both SDKs ship a `verify_bundle(path)`
      that validates an Ed25519-signed export without hitting the API.

### Type source of truth

- [ ] TypeScript SDK imports domain types from `@atlasent/types`.
      Zero local redefinition of `Permit`, `Decision`, `Policy`, etc.
      *Blocked on publishing `@atlasent/types`; types currently live
      in `typescript/src/types.ts`.*
- [ ] Python SDK's `pydantic` models are generated from the OpenAPI
      spec (`atlasent-api/openapi.yaml`), not hand-maintained.
- [x] CI drift detector in `contract/` fails if the two SDKs diverge
      on wire shape. (`contract/tools/drift.py`, wired into
      `.github/workflows/contract-ci.yml`.)

### Publish story

- [x] `@atlasent/sdk@1.0.0` tag cuts an npm publish via GitHub Actions.
      Provenance attestation, no `--no-verify`.
      (`.github/workflows/publish-npm.yml`, `npm publish --provenance`
      with `id-token: write`.)
- [x] `atlasent==1.0.0` tag cuts a PyPI release via trusted publishing
      (PEP 740 attestations). (`.github/workflows/publish-pypi.yml`.)
- [x] Both SDKs honour semver: breaking changes → minor bump on 0.x,
      major bump post-1.0. Both packages now sit at `1.0.0`.
- [x] CHANGELOG.md in each language directory.
      (Auto-generation on release is still a follow-up; changelogs are
      hand-curated per release for now.)

### Testing

- [x] Contract tests (`contract/vectors/*.json`) executed against
      both SDKs in CI. Same input → same output wire bytes.
      (`contract/tests/`, TS `test/contract-vectors.test.ts`, Python
      `tests/test_contract_vectors.py`.)
- [x] Integration suite hits a dedicated staging `atlasent-api` org
      on each PR. (`.github/workflows/integration.yml`, gated on the
      `STAGING_ATLASENT_API_KEY` secret so fork PRs stay green.)
- [x] 95%+ line coverage on the TS SDK; matching coverage on Python.
      (TS 97.9%, floor enforced at 95% in `typescript/vitest.config.ts`;
      Python 97.7% line+branch, floor enforced at 95% in
      `python/pyproject.toml`.)

### Docs + DX

- [x] `README.md` in each language directory: 3-minute quickstart,
      install, hello-world, error handling, where to get an API key.
- [x] Type-checked hello-world in each quickstart. Copy-paste must
      compile. (TS: `npm run typecheck:examples` via
      `tsconfig.examples.json`, wired into CI.)
- [x] `examples/` directory with 3-4 runnable end-to-end scripts
      (deploy gate, data-export gate, lab-record approval).
      (Python: 5 examples. TS: `basic.ts`, `deploy-gate.ts`,
      `data-export-gate.ts`.)
- [x] Errors expose `request_id` from the API for support escalation.
      (`AtlaSentError.requestId` in TS; `X-Request-ID` correlation in
      both clients' logging.)

---

## Sequencing

1. Lock the openapi.yaml contract. Generate Python `pydantic` models
   from it; delete hand-written equivalents.
2. Wire TypeScript SDK to `@atlasent/types`. Delete duplicate type
   definitions.
3. Fill endpoint parity gaps (streaming evaluate, audit verifier).
4. Cut `0.1.0` on both registries under trusted-publishing CI.
5. Add contract vectors to prevent wire drift going forward.
6. Write quickstarts + examples; verify they compile.

---

## Out of scope for V1

- Go, Ruby, Java, Rust SDKs (Go ships in a separate repo; others
  wait for customer pull).
- Browser SDK (the console already has its own thin client).
- Synchronous Python (async-only is fine; 3.11+ minimum).

---

## Risks

- **Wire drift.** Without contract vectors, Python and TS will diverge
  silently. Add the drift detector before the first 0.1.0 cut.
- **Types drift.** If `@atlasent/types` isn't yet published on npm,
  the TS SDK has to vendor it temporarily. Document the path to
  removing the vendor.
- **Publish credentials.** GitHub Actions needs npm token + PyPI
  trusted publisher configured once. Track as a one-time setup task.
