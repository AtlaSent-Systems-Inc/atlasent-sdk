# Changelog

All notable changes to `@atlasent/sdk` (TypeScript) are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] — 2026-04-18

### Added
- Multi-runtime build: a Node-shaped build (`dist/index.{js,cjs}`) plus a
  platform-neutral build (`dist/browser.js`) selected automatically via
  the `browser` / `deno` / `workerd` package.json export conditions.
- `@atlasent/sdk/browser` entry that refuses to construct the client
  when given a secret-style API key (`ask_live_*`, `ask_test_*`, `sk_*`)
  in a browser-like environment. Opt out with `{ allowBrowser: true }`.
- `detectRuntime()` helper used to assemble the `User-Agent` header
  defensively across Node, Bun, Deno, edge runtimes, and browsers.
- Internal RFC-4122 v4 fallback for `crypto.randomUUID` so the SDK
  works on runtimes where it is missing.
- Internal `setTimeout`-based fallback for `AbortSignal.timeout`.
- README runtime-support matrix and browser-usage guidance.

### Changed
- `User-Agent` is now `@atlasent/sdk/<version> <runtime>` where
  `<runtime>` is detected at request time. The previous form
  unconditionally referenced `process.version`, which threw in
  browsers and edge runtimes.
- SDK version is now injected at build time from `package.json`
  via tsup's `define`, so the `User-Agent` no longer drifts from the
  published version.
- Constructor now throws a typed `AtlaSentError` if `globalThis.fetch`
  is unavailable and no `fetch` was injected, instead of crashing on
  first request.

### Fixed
- `process.version` reference at request time crashed the SDK in any
  non-Node runtime — this is the headline bug fixed by the changes above.

## [0.4.0]

- Add `AtlaSentErrorCode` and `bad_response` error code; surface server
  messages on 401/403; full contract-vector tests wired to the shared
  `contract/vectors/` corpus.

## [0.1.0]

- Initial public TypeScript SDK with `evaluate()` and `verifyPermit()`.
