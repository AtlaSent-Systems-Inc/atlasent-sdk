# AtlaSent Evidence Package — independent verification in under 15 minutes

This is a **self-contained, hand-it-to-an-auditor package**. It lets a skeptical
auditor or security engineer independently confirm that a set of authorization
decisions is **authentic, complete-as-presented, and tamper-evident** — without
trusting AtlaSent's running system, without network access, and without taking
anyone's word for it.

You recompute the hashes, the Merkle summary, and the Ed25519 signature
yourself, against a published public key. If a single byte of the evidence was
altered, verification fails.

---

## What's in here

| File | What it is |
|---|---|
| `bundle.json` | A **signed evidence bundle** — a hash-linked chain of authorization decisions + an Ed25519 signature. This is the artifact AtlaSent produces for an audit. |
| `trust-root.json` | The **trust root** — the published Ed25519 **public** key(s) of the signing authority. No secrets. Delivered out-of-band from the bundle. |
| `verify.sh` | **One command.** Runs both verifiers and prints a single PASS/FAIL. |
| `verify.py` | Verifier using the published `atlasent[verify]` SDK (Python). |
| `verify.mjs` | Verifier using **only the Node standard library** — zero dependencies, readable top to bottom. An *independent* implementation. |
| `docs/` | Architecture, hash-chain mechanics, cryptographic assumptions, threat model, control mapping, a worked investigation, and known limitations. |

The two verifiers are **independent implementations**. Running both and getting
the same answer is two separate codebases agreeing — not one tool trusting
itself.

---

## The 60-second path

```bash
./verify.sh
```

Expected output:

```
RESULT: PASS — 2 independent verifier(s) agree the bundle is authentic and intact.
```

You can run the verifiers individually too:

```bash
# Node — zero dependencies, nothing to install
node verify.mjs

# Python — the published SDK, cryptography + stdlib only
pip install 'atlasent[verify]'
python verify.py
```

Each prints, on success:

```
PASS  bundle_id=…  key_id=evidence-issuing-2026-06  records=3  checks=signature,chain_binding,summary_hash
```

### Prove it actually checks something

Verification is only meaningful if it *fails* on a bad bundle. Point either
verifier at one of the tamper fixtures in the SDK's
`contract/vectors/evidence-bundles/` and watch it reject:

```bash
node verify.mjs ../contract/vectors/evidence-bundles/entry-tampered.json trust-root.json
# FAIL  record[2].entry_hash does not match recomputed content hash   (exit 1)

node verify.mjs ../contract/vectors/evidence-bundles/tampered-signature.json trust-root.json
# FAIL  signature_invalid: Ed25519 signature did not verify           (exit 1)
```

Flip one byte of `bundle.json` yourself and re-run — it will fail.

---

## The three checks, in plain terms

`verify` passes only if **all three** hold (there is no partial-pass state):

1. **Signature** — the whole bundle is signed with Ed25519 by a key whose
   public half is in `trust-root.json`. Confirms *who* issued it and that the
   bytes are unmodified since signing.
2. **Chain binding** — each decision record carries `entry_hash =
   sha256(prev_hash ‖ canonical(record))`, and each `prev_hash` links to the
   record before it. This is a hash chain: changing, reordering, inserting, or
   deleting any record breaks it.
3. **Summary (Merkle root)** — `summary_hash` is the RFC 6962 Merkle root over
   the record hashes, so the signature commits to the exact set and order of
   records.

Full mechanics: [`docs/02-hash-chain.md`](docs/02-hash-chain.md).

---

## Read these next (5 minutes each)

- [`docs/01-architecture.md`](docs/01-architecture.md) — what AtlaSent is and where this evidence comes from (one diagram).
- [`docs/04-threat-model.md`](docs/04-threat-model.md) — **what this proves and, just as important, what it does not.**
- [`docs/05-control-mapping.md`](docs/05-control-mapping.md) — SOC 2, 21 CFR Part 11, EU Annex 11, GxP.
- [`docs/03-cryptographic-assumptions.md`](docs/03-cryptographic-assumptions.md) — the exact primitives and what you must trust.
- [`docs/06-investigation-workflow.md`](docs/06-investigation-workflow.md) — a worked example: investigating an alleged unauthorized action.
- [`docs/07-known-limitations.md`](docs/07-known-limitations.md) — the honest boundaries.

---

## Trust posture in one paragraph

The only thing you must obtain through a trusted channel is `trust-root.json`
(the public key) — get it from AtlaSent out-of-band and pin it. Everything else
is checkable math. The verifiers make **no network calls**, so a correct PASS
cannot depend on AtlaSent being online, cooperative, or honest at verification
time. A standard offline assumption applies: SHA-256 and Ed25519 are not broken.
See [`docs/03-cryptographic-assumptions.md`](docs/03-cryptographic-assumptions.md).
