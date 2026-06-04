# Evidence-bundle reference fixtures

Cross-language test vectors for the offline evidence-bundle reference verifiers
(`atlasent-sdk/python/atlasent/evidence_bundle_verifier.py` and
`atlasent-sdk/typescript/src/evidence-bundle-verifier.ts`). Both verifiers read
the *same* files here, so a passing run on both sides proves they agree
byte-for-byte on canonicalization and Ed25519 interop.

| File | Expected verdict |
|---|---|
| `valid-3-records.json` | valid |
| `tampered-signature.json` | `signature_invalid` |
| `broken-chain.json` | `chain_broken` |
| `unknown-key.json` | `unknown_key_id` |
| `anchor-mismatch.json` | `chain_anchor_mismatch` |
| `summary-mismatch.json` | `summary_hash_mismatch` |
| `entry-tampered.json` | `chain_broken` |
| `key-set.json` | pinned issuing-key public component |

Regenerate deterministically (fixed Ed25519 seed) with:

```
python3 contract/vectors/evidence-bundles/_generate.py
```

See `atlasent-docs/architecture/evidence-bundles-spec.md` §4–§5 for the format.
