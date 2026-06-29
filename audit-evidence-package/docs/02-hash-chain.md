# Hash chain & signature mechanics — exactly what `verify` recomputes

This is the precise algorithm. Both verifiers in this package implement it; you
can read the ~120-line `verify.mjs` to see every step in code. Nothing here is
hidden or proprietary — it is standard SHA-256 + Ed25519 + an RFC 6962 Merkle
tree over a canonical JSON encoding.

## 0. Canonical JSON

All hashing and signing is over a **canonical** JSON encoding so that two
implementations produce byte-identical input:

- Object keys sorted lexicographically, at every depth.
- No insignificant whitespace.
- Strings encoded as standard JSON string literals with raw UTF-8 (not
  `\uXXXX`) for non-ASCII — matching JavaScript `JSON.stringify` and the
  RFC 8785 (JCS) intent.
- Integers as their shortest decimal form; floating-point is rejected (v1
  bundles do not contain floats).

`null` → `null`, `true`/`false` literal, arrays preserve order.

## 1. Per-record entry hash (the chain)

For each record, with its `entry_hash` (and any `signature`) field removed:

```
content        = record without {entry_hash, signature}
prev_hash_bytes = hex-decode(record.prev_hash)          # 32 bytes; genesis = 32 zero bytes
entry_hash      = SHA256( prev_hash_bytes ‖ UTF8(canonical_json(content)) )   # hex
```

The verifier recomputes `entry_hash` for every record and requires it to equal
the stored value. Because `content` includes `prev_hash`, and `entry_hash` folds
in the *bytes* of the previous hash, the records form a **hash chain**:

- **Edit** any field of any record → its `entry_hash` changes → mismatch.
- **Reorder / insert / delete** a record → a `prev_hash` no longer links → break.

The verifier also walks the links explicitly: starting from
`chain_context.first_prev_hash`, each record's `prev_hash` must equal the prior
record's `entry_hash`.

## 2. Chain anchors

`chain_context` pins this slice into the larger, ongoing chain and is itself
covered by the signature:

```
chain_context.entry_count      == len(records)
records[0].entry_hash          == chain_context.first_entry_hash
records[last].entry_hash       == chain_context.last_entry_hash
records[0].prev_hash           == chain_context.first_prev_hash
```

Any mismatch is a `chain_anchor_mismatch` failure (see the `anchor-mismatch`
fixture).

## 3. Summary hash (Merkle root)

`summary_hash` is the **RFC 6962** Merkle tree hash over the record
`entry_hash` leaves:

```
leaf(h)        = SHA256( 0x00 ‖ hex-decode(h) )
node(l, r)     = SHA256( 0x01 ‖ l ‖ r )
odd node       promoted unchanged to the next level
empty tree     = SHA256("")
```

The verifier recomputes the root from the records and requires it to equal
`summary_hash`. This binds the signature to the exact multiset **and order** of
records (`summary-mismatch` fixture exercises a tampered root).

## 4. Signature

```
signing_input = bundle without the "signature" field
digest        = SHA256( UTF8(canonical_json(signing_input)) )      # 32 bytes
verify        = Ed25519_Verify(pubkey, message = digest, sig = base64-decode(signature_b64))
```

- `pubkey` is resolved from `trust-root.json` by `signature.key_id`; the entry's
  `alg` must be `Ed25519`. An unresolvable key is `unknown_key_id`
  (`unknown-key` fixture).
- Ed25519 (RFC 8032 / EdDSA over Curve25519) verifies the 32-byte SHA-256
  digest as its message. A flipped signature or wrong key is
  `signature_invalid` (`tampered-signature`, `wrong-key` fixtures).

Because the signature covers the canonical bundle — which contains the records,
the anchors, and the Merkle root — a valid signature plus the recomputed hashes
together certify the **whole** structure.

## Result

`verify` returns success only if **signature ∧ chain_binding ∧ summary_hash**
all hold. There is no partial-validity state by design: a bundle is either
intact and authentic, or it is not evidence.
