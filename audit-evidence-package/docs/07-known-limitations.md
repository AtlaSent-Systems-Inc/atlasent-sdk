# Known limitations

Stated up front, because a vendor that hides these is not one you should trust
with your audit trail. None of these undermine a PASS *for what it claims*; they
bound what it claims.

## 1. Completeness across the full history is a separate question

Verification proves the records **in this bundle** are intact and contiguous
between their anchors. It does **not**, on its own, prove that the export is the
complete set of relevant decisions, or that no records exist outside the window.
"Is this set intact?" (answered here) and "is this the *right and whole* set?"
(answered by reconciling `chain_context` against the authority's published chain
head / external anchoring) are distinct. For a completeness assertion, reconcile
the anchors, don't infer it from a PASS.

## 2. The decision record is not, by itself, proof of execution

A record proves an authorization *decision* occurred and was recorded. It does
not by itself prove the downstream system executed exactly and only what was
authorized. That binding (executed action ↔ permit) is a separate
runtime-execution verification artifact. If your control depends on
"the action matched the authorization," request that evidence explicitly.

## 3. Permit single-use is enforced online, not in the offline bundle

Replay prevention (a permit consumed exactly once) is enforced server-side by a
nonce ledger at execution time. The offline bundle records that decisions and
verifications happened; it is not a live check that a specific permit was not
replayed. For that property, the online verification path is authoritative.

## 4. Trust-root authenticity is your responsibility

The package cannot bootstrap trust in the signing key. You must obtain
`trust-root.json` out-of-band and pin it. A bundle that verifies against a
*bogus* trust root proves nothing. See
[`03-cryptographic-assumptions.md`](03-cryptographic-assumptions.md).

## 5. Signing-key compromise is the hard boundary

A holder of the signing private key can forge bundles. Integrity against
everyone *else* is cryptographic; integrity against the key custodian is an
operational/key-management control (HSM/KMS custody, rotation, monitoring),
outside what offline verification can attest.

## 6. Approver identity strength lives in the approval artifact

The bundle's signature attests to the *signing authority*, not to the human
identity of an approver named inside a record. Where a decision rests on a human
approval, the strength of that human attestation comes from the approval
artifact and its identity assertion — verify those as their own objects.

## 7. Algorithm suite is fixed in v1

v1 is SHA-256 + Ed25519. Should either need replacing, the explicit `alg` fields
allow an additive new suite; verifiers reject an unknown `alg` rather than
accepting it. Today, a v1 verifier only validates v1 bundles.

## 8. This package ships a sample bundle

The `bundle.json` here is a **shared test vector**, included so you can exercise
the verifiers immediately. For a real audit, verify a bundle exported from the
actual regulated organization's chain — the mechanics are identical.

## 9. Floating-point and non-canonical inputs are rejected

The canonical encoding rejects floating-point values (v1 bundles do not contain
them) and assumes well-formed JSON. This is a deliberate determinism guarantee,
not a gap — but it means a bundle must conform to the v1 canonical form to
verify.

---

If any of these limitations matters to a specific control you are testing, raise
it directly — the answer is either "here is the companion evidence that covers
it" or "that is genuinely out of scope for this artifact," and both are honest.
