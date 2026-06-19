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

Note: publishing remains a manual, maintainer-gated step — this change only
makes a real version available; it does not enable any auto-publish.
