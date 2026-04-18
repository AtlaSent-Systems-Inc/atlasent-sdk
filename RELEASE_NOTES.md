# Release Notes — v1.0.0

**Release date:** 2026-04-17

## AtlaSent SDK v1.0.0

First stable release of the AtlaSent TypeScript and Python SDKs.

### TypeScript (`@atlasent/sdk`)

- `authorize(request)` — evaluate an action and receive a decision + permit token
- `verifyPermit(token)` — consume a permit at execution time (single-use enforcement)
- `withGate(fn, request)` — higher-order function wrapping any async operation
- `verifyAuditExport(envelope)` — offline Ed25519 + hash-chain verification (no network required)
- Typed errors: `AtlasentAuthorizationError`, `AtlasentNetworkError`, `AtlasentConfigError`
- Isomorphic canonicalizer (Node.js + browser)
- Fail-closed: throws on network error or denied decision

### Python (`atlasent`)

- `authorize(request)` — sync and async variants
- `@guard` decorator — wraps any function, raises `AuthorizationError` on deny
- Typed errors with `AuthorizationError.decision` for downstream handling
- LRU permit cache (configurable TTL)
- Zero mandatory dependencies beyond `httpx`

### Breaking changes from pre-release

None — this is the first stable release. Pre-release users should pin to `>=1.0.0,<2.0.0`.

### Upgrade notes

```bash
npm install @atlasent/sdk@1.0.0
pip install atlasent==1.0.0
```

### Stability guarantees

All public exports in `index.ts` / `atlasent/__init__.py` are stable as of v1.0.0. Internal modules (`_internal/`) are not part of the public API.
