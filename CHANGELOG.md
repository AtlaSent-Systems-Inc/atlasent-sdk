# Changelog

## 0.1.0 — 2025-01-15

### Added

- `AtlaSentClient` with `evaluate()` and `verify_permit()` methods
- Top-level `authorize()` convenience function
- Global `configure()` for API key and environment settings
- `AuthorizationResult` dataclass with boolean conversion
- Custom exceptions: `AtlaSentError`, `PermissionDeniedError`, `ConfigurationError`
- Automatic fallback to `ATLASENT_API_KEY` environment variable
- 10-second request timeout with clear error messages
- Full test suite with mocked HTTP
- Examples: basic usage, clinical data agent, batch evaluation
