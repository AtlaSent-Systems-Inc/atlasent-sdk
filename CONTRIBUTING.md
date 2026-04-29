# Contributing to atlasent-sdk

Thanks for your interest in contributing to the AtlaSent SDK.

## Ground rules

1. **Discuss first.** For non-trivial changes, open an issue before writing code.
2. **Small PRs.** Keep pull requests focused — one feature or fix per PR.
3. **Backwards compatibility.** The SDK is consumed by customer code. Breaking changes require a major version bump and explicit release notes.
4. **Tests.** New code should have tests. Bug fixes should include a failing test that your change makes pass.
5. **Style.** Run the linter before opening a PR (`npm run lint` / `ruff check .`).

## Development setup

```bash
git clone https://github.com/AtlaSent-Systems-Inc/atlasent-sdk
cd atlasent-sdk

# TypeScript
cd typescript && npm install && npm test

# Python
cd python && pip install -e ".[dev]" && pytest
```

## Pull request checklist

- [ ] Tests pass locally
- [ ] Linter passes
- [ ] `RELEASE_NOTES.md` updated for any user-visible changes
- [ ] Relevant docs updated

## Reporting a security issue

Email **security@atlasent.io**. We acknowledge within 2 business days. Do not open a public issue for security-sensitive reports.

## License

By contributing, you agree that your contributions are licensed under the same license as this repository (see [`LICENSE`](./LICENSE)).
