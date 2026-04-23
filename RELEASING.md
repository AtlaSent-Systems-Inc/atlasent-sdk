# Releasing the AtlaSent SDKs

Publish procedure for the Python (`atlasent` on PyPI) and TypeScript
(`@atlasent/sdk` on npm) SDKs. The two packages version independently;
each has its own git-tag prefix and its own publish workflow.

## Tag convention

| Package         | Tag format               | Workflow                              |
|-----------------|--------------------------|---------------------------------------|
| `atlasent` (py) | `python-v<semver>`       | `.github/workflows/publish-pypi.yml`  |
| `@atlasent/sdk` | `typescript-v<semver>`   | `.github/workflows/publish-npm.yml`   |

A single push can trigger **one** of these workflows, not both — the
tag-prefix filters are mutually exclusive. Push two tags if you're
releasing both languages at once.

## Pre-flight (both languages)

Before tagging:

1. The CHANGELOG entry for the release is on `main` under the right
   version heading (e.g. `## 1.2.0 — 2026-04-23`).
2. The version in the source matches the CHANGELOG heading:
   - Python: `python/atlasent/_version.py` → `__version__`.
   - TypeScript: `typescript/package.json` → `"version"`.
3. The contract suite is green on `main`
   (`contract/tools/drift.py` — runs in CI).
4. Per-language CI is green on `main` (`python-ci.yml` /
   `typescript-ci.yml`).

The publish workflows refuse to publish if the git tag version and
the in-source version disagree, but catching the mismatch locally is
cheaper than failing a workflow.

## Python release

```bash
# Bump python/atlasent/_version.py and python/CHANGELOG.md; land via PR.
# Once merged to main:
git checkout main && git pull
git tag python-v1.2.0
git push origin python-v1.2.0
```

The `publish-pypi.yml` workflow then:

1. Runs `pytest` across Python 3.10 / 3.11 / 3.12.
2. Verifies `python-v<semver>` matches `atlasent._version.__version__`.
3. `python -m build` → sdist + wheel.
4. `twine check dist/*`.
5. Installs the freshly-built wheel in a clean venv and smoke-imports
   the public surface (`protect`, `authorize`, `AtlaSentClient`,
   `AsyncAtlaSentClient`, `AtlaSentError`, `AtlaSentDeniedError`).
6. Publishes via **PyPI trusted publishing (OIDC)** — PEP 740
   attestations are generated and uploaded automatically. No
   `PYPI_TOKEN` secret.

First-time setup (once per project): configure the trusted publisher
at <https://pypi.org/manage/account/publishing/> pointing at this
repo and the `publish-pypi.yml` workflow. The `environment: pypi`
gate in the workflow is the GitHub Environment name PyPI expects.

Post-publish: check the release on PyPI
(<https://pypi.org/project/atlasent/>) and that
`pip install atlasent==<version>` resolves from a clean cache.

## TypeScript release

```bash
# Bump typescript/package.json ("version") and typescript/CHANGELOG.md;
# land via PR. Once merged to main:
git checkout main && git pull
git tag typescript-v1.2.0
git push origin typescript-v1.2.0
```

The `publish-npm.yml` workflow then:

1. Runs `npm run typecheck`, `npm test`, and `npm run build` across
   Node 20 and 22.
2. Verifies `typescript-v<semver>` matches `package.json` `"version"`.
3. `npm pack --dry-run` — the exact file list that will ship is
   logged in the Actions output. Inspect it on first release.
4. `npm publish --access public --provenance` — Sigstore attestations
   link the tarball to this workflow run.

First-time setup (once per project): store an automation token with
*Publish* scope as the repo secret `NPM_TOKEN`. Provenance requires
`id-token: write` permission (already set in the workflow).

Post-publish: check the release on npm
(<https://www.npmjs.com/package/@atlasent/sdk>) and that
`npm view @atlasent/sdk@<version>` resolves. The provenance badge on
the npm page confirms the Sigstore attestation.

## If a publish fails

- **Tag / version mismatch**: delete the tag locally
  (`git tag -d <tag>`) and on origin
  (`git push origin :refs/tags/<tag>`), land a follow-up PR that
  fixes the version in source, re-tag.
- **Tests fail after tag**: same procedure — fix on `main`, re-tag.
  Never skip the tests to force a publish.
- **Publish succeeds but artifact is broken**: bump the patch
  version and release again. Both PyPI and npm forbid republishing
  the same version number, and yanking / deprecating is a weaker
  signal than a clean patch release.

## Coordinated cross-language release

When `atlasent` and `@atlasent/sdk` ship together (e.g. a new
primitive added to both), push both tags in the same command so the
workflows run side-by-side:

```bash
git tag python-v1.2.0
git tag typescript-v1.2.0
git push origin python-v1.2.0 typescript-v1.2.0
```

Update `RELEASE_NOTES.md` at the repo root with the combined surface
before tagging.
