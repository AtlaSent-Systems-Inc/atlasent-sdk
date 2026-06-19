# Changelog — atlasent-enforce

## 0.1.0a1 (unreleased)

First publishable alpha. The package was previously pinned at the unbuildable
`0.0.0` placeholder.

### Changed
- Version is now sourced from `atlasent_enforce/_version.py` (`0.1.0a1`) via
  setuptools dynamic metadata, mirroring the main `atlasent` package. This
  makes the package buildable/publishable; the implementation (the
  non-bypassable `Enforce.run()` wrapper and the SIM-01..SIM-12 gate) is
  unchanged.

### Release path
- Publishing is maintainer-gated by tag: push `enforce-py-v<version>` (matching
  `_version.py`) to trigger `.github/workflows/publish-pypi-enforce.yml`, which
  tests, builds, smoke-tests, passes the AtlaSent release gate, and publishes
  via PyPI OIDC trusted publishing. Nothing publishes on a normal merge — only
  on that explicit tag (or a manual `workflow_dispatch`). The PyPI trusted
  publisher for `atlasent-enforce` must be configured once to point at this
  workflow + the `pypi` environment.
