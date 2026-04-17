# SDK Compatibility Matrix

| Feature | Python SDK | TypeScript SDK |
|---------|-----------|---------------|
| `evaluate` | ✓ | ✓ |
| `verify_permit` | ✓ | ✓ |
| Sync client | ✓ | — |
| Async client | ✓ | ✓ (native) |
| Guard decorator | ✓ | ✓ (`withGate`) |
| Auto-retry (3x, exp backoff) | ✓ | ✓ |
| Response caching (TTL) | ✓ | — |
| Permit chain verification | ✓ | ✓ |
| Custom timeout | ✓ | ✓ |
| Context manager / `using` | ✓ | — |
| Minimum runtime | Python 3.11 | Node 18 / browsers |
| Wire format version | `v1` | `v1` |

Permit tokens issued by the Python SDK are verifiable by the TypeScript SDK
and vice-versa — they are opaque server-issued JWTs; SDKs do not decode them.
