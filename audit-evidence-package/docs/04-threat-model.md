# Threat model — what this proves, and what it does not

The fastest way to mis-trust a piece of evidence is to assume it proves more
than it does. This page draws the line precisely.

## What a PASS proves

If `verify` returns PASS against a trust root you have authenticated, you can
rely on **all** of the following:

1. **Authenticity of origin.** The bundle was signed by the holder of the
   private key matching `signature.key_id` in your trusted set. Absent private-key
   compromise, only AtlaSent's signing authority could have produced it.
2. **Integrity.** Not a single byte of the signed content has changed since
   signing. Any edit to any field of any record — or to the anchors or the
   summary — makes verification fail.
3. **Order and completeness *as presented*.** The records are a contiguous,
   correctly-ordered hash chain, and the signature commits (via the Merkle root
   and the anchors) to exactly this set and order. You cannot silently add,
   drop, reorder, or alter a record within the bundle.
4. **That these specific authorization decisions were recorded.** Each record
   attests that AtlaSent evaluated a particular `decision_id` and reached a
   particular `decision` (`allow` / `deny` / `hold` / `escalate`), bound into the
   chain at that position.
5. **Independently and offline.** None of the above depends on AtlaSent's
   systems being available, cooperative, or honest at the time you check.

## What a PASS does NOT prove

Equally important — do not over-rely:

1. **Not policy correctness.** The bundle proves a decision was *made and
   recorded*, not that it was the *right* decision. Whether the policy that
   produced an `allow` was appropriate is a separate review (inspect the policy
   and the decision context, not just the signature).
2. **Not faithful downstream execution by itself.** A record proves the
   authorization decision. It does not, on its own, prove that the real-world
   system then executed exactly and only what was authorized. AtlaSent addresses
   that with separate runtime/execution verification (binding the executed action
   back to its permit); if your control depends on it, ask for that evidence
   too — do not infer it from the decision record alone.
3. **Not global completeness.** Verification proves the records *in this bundle*
   are intact and contiguous **between their anchors**. It does not, by itself,
   prove that no decisions exist *outside* the exported window, or that the
   window you were given is the window you should have received. Completeness
   across the full history is addressed by the chain's external anchoring /
   transparency mechanism and by reconciling `chain_context` against the
   authority's published chain head — treat "is this the complete set?" as a
   distinct question from "is this set intact?".
4. **Not identity beyond the signing key.** The signature attests to the signing
   authority, not to the human identity of any approver named inside a record.
   Where a decision rests on a human approval, the strength of *that* attestation
   comes from the approval artifact and its identity assertion, which are their
   own verifiable objects — assess them on their own merits.
5. **Not liveness or single-use of permits.** Permit single-use (replay
   prevention) is enforced server-side via a nonce ledger at execution time. The
   offline bundle records that decisions and verifications occurred; it is not a
   live check that a given permit was consumed exactly once. See
   [`07-known-limitations.md`](07-known-limitations.md).

## Adversaries considered

| Adversary | Can they defeat a PASS? | Why / why not |
|---|---|---|
| Tampering intermediary (edits the bundle in transit or at rest) | **No** | Any edit breaks a hash or the signature. |
| Dishonest / compromised AtlaSent backend *at verification time* | **No** | Verification is offline; it never asks the backend anything. |
| Party who reorders, inserts, or deletes records | **No** | Breaks the `prev_hash` links, the anchors, and the Merkle root. |
| Party substituting a different signing key | **No** | The key must already be in *your* pinned trust root. |
| Holder of the **signing private key** | **Yes** | Can forge bundles. This is the key-management boundary — see below. |
| Party who controls **which records get exported** | **Partially** | Cannot alter what is in the bundle, but completeness of the *selection* is a separate question (#3 above). |
| Party who gives you a **bogus trust root** | **Yes, if you accept it** | Hence the out-of-band, pinned trust-root requirement ([`03`](03-cryptographic-assumptions.md)). |

## The two real trust boundaries

Everything reduces to two assumptions you must manage outside this package:

1. **The signing private key is not compromised.** (AtlaSent's key custody.)
2. **The trust root you pinned is authentic.** (Your out-of-band verification.)

Hold those two, and a PASS is strong, independent evidence. This honesty is the
point: a control built on this should cite exactly properties #1–#5 of "what a
PASS proves," and not the items under "what it does not."
