# Changelog

## [1.1.0] - 2026-04-18

### Added
- `AsyncAtlaSentClient` with `authorize()`, `verify_permit()`, and `authorize_many()` for concurrent batch evaluation
- `atlasent.testing.MockAtlaSentClient` — drop-in mock for unit tests, no API key required
- `atlasent.tracing` module with optional OpenTelemetry span instrumentation (graceful no-op if OTel not installed)
- `@gate(on_denied=...)` parameter: `"raise"` (default), `"return_none"`, or `"log"`

### Changed
- Version bumped to 1.1.0

## [1.0.0] - 2026-04-18

### Added
- Initial release with `AtlaSentClient`, `@gate` decorator, `authorize()`, `verify_permit()`
- PyPI publish workflow
