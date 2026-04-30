# SDK Publish Readiness

The `atlasent` Python package and `@atlasent/sdk` TypeScript package
are the surfaces customer engineering teams touch first. This document
is the punch-list for what has to be true before each release tag
gets pushed to PyPI or npm — and the recovery procedure when something
goes wrong on a publish.

## Pre-publish gate (both languages)

- [ ] **CI green on the release tag.** All matrix entries pass: type
  check, unit tests, contract-vector replay against latest API, lint,
  formatter check.
- [ ] **CHANGELOG.md** has an entry for the new version with date.
- [x] **Version bump** is the only diff in the version-bump commit
  (no API changes co-mingled — review surface stays small).
- [ ] **Contract vectors current.** Run `pnpm contract:replay` /
  `pytest tests/contract/` against `https://api.atlasent.io` (live
  prod) and confirm green. Stale vectors mean we'll publish an SDK
  that drifts from prod the moment a customer installs it.
- [ ] **README install snippet works** from a fresh sandbox.
  `docker run --rm -it python:3.12 sh -c 'pip install atlasent==<v> && python -c "import atlasent"'`.
- [ ] **`protect()` round-trip** against a staging tenant works:
  allow returns a Permit; deny raises `AtlaSentDeniedError`. Cross-
  language parity verified.
- [ ] **No secrets in the package.** `python -m build && unzip -l
  dist/*.whl | grep -i 'env\|secret\|key'` returns nothing. Same
  for `npm pack && tar tzf *.tgz | grep -i 'env\|secret\|key'`.

## Python (PyPI) specific

- [ ] **`_version.py`** matches the git tag (`v1.1.0` → `__version__
  = "1.1.0"`).
- [x] **`pyproject.toml`** declares `requires-python = ">=3.9"`.
  Anything stricter cuts off enterprise customers stuck on 3.10.
- [x] **Trove classifiers** include the supported Python versions and
  `Development Status :: 5 - Production/Stable`.
- [x] **`extras`**: `httpx` is hard, `cryptography` is optional under
  `[verify]` extra so the base install stays small.
- [x] **`README.md`** is set as `readme` in `pyproject.toml` so PyPI
  renders the right thing.
- [x] **Trusted publishing** configured: `.github/workflows/publish-
  python-sdk.yml` uses `id-token: write` and PyPI's GitHub OIDC
  trusted publisher (no API tokens on disk).
- [ ] **Dry-run** with `python -m twine upload --repository testpypi`
  succeeds. Verify install from TestPyPI.
- [x] **Sigstore signing** enabled — `pypa/gh-action-pypi-publish` with
  `attestations: true`.

## TypeScript (npm) specific

- [ ] **`package.json` version** matches the git tag.
- [x] **`engines.node`** is `>=18` (Node 18 is the LTS floor we
  support).
- [x] **ESM + CJS dual build.** `dist/index.js` (ESM, package `"type":"module"`)
  and `dist/index.cjs` (CJS) built by tsup; `exports` field routes each.
- [x] **`exports` field** in `package.json` points to both ESM and CJS.
  No `main`-only fallback.
- [x] **TypeScript types** ship: `dist/index.d.ts` and `.d.cts` exist.
- [x] **Provenance**: workflow uses `npm publish --provenance`
  (requires GitHub Actions OIDC → npm trusted publishing).
- [x] **No `dependencies` larger than `zod`.** `dependencies: []` — zero
  hard runtime deps.
- [x] **`peerDependencies` for OTel** declared; `@atlasent/otel` ships as
  a separate package and is never bundled into `@atlasent/sdk`.

## Recovery procedures

### "I published a bad version to PyPI"

PyPI does not allow re-uploads of the same version. Procedure:

1. Yank the broken version: `python -m twine yank atlasent==X.Y.Z`
   (PyPI hides it from new installs but keeps it for repro).
2. Bump to `X.Y.Z+1` (PEP 440 micro increment).
3. Re-run the publish workflow.
4. Notify in `#atlasent-sdk` Slack channel and add a CHANGELOG
   `### Yanked` note under the bad version.

### "I published a bad version to npm"

1. Within 72 hours: `npm unpublish @atlasent/sdk@X.Y.Z` (npm allows
   unpublish during this window).
2. After 72 hours: deprecate with `npm deprecate @atlasent/sdk@X.Y.Z
   "<reason>"` and publish a patched `X.Y.Z+1`.
3. Notify in `#atlasent-sdk` Slack channel.

### "The contract-replay job is red against prod"

The SDK is publishing for an API surface that's drifted. Do NOT
bypass with `--no-verify` or skip the job. Either:

- Pin the SDK release to the previous API release tag (`atlasent-api
  v1.0.0` → SDK v1.0.x), or
- Update the contract vectors to match the current API and ship the
  vector update in the same SDK release.

## Post-publish

- [ ] PyPI page renders correctly (README, install snippet,
  classifiers).
- [ ] npmjs.com page renders correctly + provenance badge visible.
- [ ] `pip install atlasent` from a clean venv installs the new
  version and `import atlasent; atlasent.__version__` matches.
- [ ] `npm install @atlasent/sdk` from a clean dir works.
- [ ] **GitHub release** drafted with CHANGELOG excerpt + signing
  artifacts attached.
- [ ] **Docs site** rebuilt against the new API reference (atlasent-
  docs CI auto-trigger on tag).
- [ ] **Examples repo** version bumped (`atlasent-examples` golden-
  path package.json).
- [ ] Announce in customer Slack + monthly newsletter.

## Versioning policy

Semver. Cross-language: Python and TypeScript SDKs publish in lock-
step on the same version number. A `1.2.0` Python release implies a
`1.2.0` TypeScript release the same day, with identical `protect()`
behavior.

Breaking changes go through:

1. Deprecation warning in version `N.x` — logged on first use.
2. Major bump to `N+1.0.0` — deprecated path removed.
3. Migration guide in `docs/migration-guide-vN.md`.

Never break the wire contract in a minor. The API has its own
versioning (`/v1/...`); SDK majors do not bump it.
