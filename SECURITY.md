# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in this repository, **do not open a public GitHub issue**. Email [security@atlasent.io](mailto:security@atlasent.io) with:

- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept (if available)
- The version or commit SHA where you observed the issue
- Your contact information for follow-up

We acknowledge all reports within **2 business days** and will coordinate disclosure on a timeline agreed with the reporter before any public advisory.

## Scope

| In scope | Out of scope |
|----------|--------------|
| `atlasent-sdk` TypeScript SDK (`/typescript`) | The AtlaSent SaaS service itself |
| `atlasent-sdk` Python SDK (`/python`) | Third-party dependencies (report upstream) |
| Permit verification logic (`verify()`) | Social engineering or phishing |
| API key transmission and storage patterns | Theoretical issues without PoC |
| Input validation and injection risks in SDK methods | Reports against demo/test environments |

For vulnerabilities in the AtlaSent service or API, use the same email — they are handled by the same security team.

## Supported versions

| Version | Supported |
|---------|-----------|
| Latest release on `main` | Yes |
| Previous minor release | Security fixes only |
| Older versions | No |

Check [npm](https://www.npmjs.com/package/@atlasent/sdk) and [PyPI](https://pypi.org/project/atlasent/) for the latest release.

## Disclosure policy

1. Reporter submits to security@atlasent.io
2. We acknowledge within 2 business days
3. We investigate and determine severity (CVSS score where applicable)
4. We develop and test a fix in a private fork
5. We coordinate a disclosure date with the reporter (typically 14–90 days, depending on severity)
6. We release patched SDK versions on npm and PyPI
7. We publish a GitHub Security Advisory
8. Reporter is credited in the advisory unless they request anonymity

We follow [responsible disclosure](https://cheatsheetseries.owasp.org/cheatsheets/Vulnerability_Disclosure_Cheat_Sheet.html) principles and will not pursue legal action against researchers acting in good faith.

## Severity definitions

| Severity | Example | Target fix timeline |
|----------|---------|--------------------|
| Critical | Permit forgery, auth bypass in `verify()` | 24–48 hours |
| High | API key leakage in SDK internals, SSRF | 7 days |
| Medium | Timing attacks on verification, info disclosure | 30 days |
| Low | Minor logic errors, low-impact edge cases | 90 days |

## Security architecture overview

For context when reporting issues:

- **API key handling**: Keys are passed as Bearer tokens in Authorization headers; they are never logged by the SDK. Callers are responsible for not embedding keys in client-side bundles.
- **Permit verification**: `verify()` validates Ed25519 signatures on permit payloads. The signature key is fetched from the AtlaSent API at verification time — it is never bundled in the SDK.
- **Network requests**: By default, SDK calls target the AtlaSent API (`https://api.atlasent.io/v1-evaluate` and `https://api.atlasent.io/v1-verify-permit`) unless a caller provides an explicit `baseUrl` override.
- **No persistent state**: The SDK does not persist credentials, tokens, or permit payloads to disk. Optional in-memory TTL caching can be enabled explicitly by callers for repeated evaluation requests.
- **Python**: Uses `httpx` for both sync and async transport. TLS verification is always enabled and cannot be disabled via public SDK API.
- **TypeScript**: Uses native `fetch`. Runs in Node 18+ and modern browsers. No polyfills that could alter TLS behavior.

## Known limitations

- SDK versions older than the last minor release are not patched. Upgrade to the latest release.
- `baseUrl` override allows callers to point the SDK at a non-AtlaSent host. This is intentional for self-hosted deployments; callers must ensure the target host is trusted.

## Security contact

- **Email**: security@atlasent.io
- **PGP**: Available on request
- **Response SLA**: 2 business days for acknowledgement
