# Cryptographic assumptions & trust model

A verification is only as strong as the assumptions behind it. Here are all of
them, stated plainly.

## Primitives

| Primitive | Standard | Used for | Assumption you rely on |
|---|---|---|---|
| **SHA-256** | FIPS 180-4 | record `entry_hash`, the chain links, the RFC 6962 Merkle `summary_hash`, and the pre-signature digest | Second-preimage and collision resistance — an adversary cannot find a different input with the same hash. |
| **Ed25519** | RFC 8032 (EdDSA / Curve25519) | the bundle `signature` | EUF-CMA security — without the private key, an adversary cannot forge a signature over a chosen message. |
| **Canonical JSON** | RFC 8785 (JCS) intent | making the hash/signature input deterministic across implementations | Both signer and verifier serialize identically (this package ships two independent implementations that agree, including on a non-ASCII bundle). |

These are standard, widely-reviewed primitives. The verifiers use platform
crypto — Python via the `cryptography` package (OpenSSL); Node via the
built-in `node:crypto` (OpenSSL) — not bespoke implementations.

## The one thing you must establish out-of-band

**The trust root.** `trust-root.json` contains only **public** keys, but you
must be confident those keys genuinely belong to AtlaSent's signing authority.
The package cannot bootstrap that for you — it is the irreducible trust anchor.

Practical guidance:
- Obtain `trust-root.json` through a **separate channel** from the bundle (e.g.
  AtlaSent's published key endpoint / documentation / a key you were given at
  onboarding), and pin it.
- Confirm the bundle's `signature.key_id` resolves to a key with the role you
  expect (audit-issuing).
- Record the public-key fingerprint you pinned in your workpapers, so a later
  re-verification uses the same anchor.

If the trust root is authentic, **everything else in the bundle is checkable
math** and requires no further trust in AtlaSent.

## What you do NOT have to trust

- **You do not trust AtlaSent's servers.** Verification is fully offline; a
  correct PASS cannot be manufactured by a compromised or dishonest backend at
  verification time.
- **You do not trust this package's authors over your own eyes.** `verify.mjs`
  has zero third-party dependencies and is short enough to read entirely. If you
  prefer, re-implement the algorithm in [`02-hash-chain.md`](02-hash-chain.md)
  in a language you trust — it will agree.
- **You do not trust a single implementation.** Two independent verifiers ship
  here; agreement between them rules out an implementation-specific bug masking
  a tampered bundle.

## Key rotation & revocation

The trust root is a **set** of keys, each with a `key_id`, so the signing key
can rotate without invalidating historical bundles: an old bundle still verifies
against the key that signed it, as long as that public key remains in the
trusted set with its original `key_id`. If a key is compromised, AtlaSent
publishes an updated trust root that omits/marks it; re-pin from that snapshot.
Revocation status is a property of the **trust root you choose to pin**, not of
the offline bundle — verify against the snapshot appropriate to your review.

## Algorithm agility

v1 fixes SHA-256 + Ed25519. The bundle and key entries carry explicit `alg`
fields, so a future suite can be introduced additively without breaking existing
verifiers (which reject an `alg` they do not implement rather than silently
accepting it).
