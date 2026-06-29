# Sample investigation workflow

A worked example of using the evidence in an actual inquiry. The point is to
show that the bundle answers real questions deterministically, not just that it
"verifies."

## Scenario

A production deployment went out on a Friday night. On Monday, someone asks:

> "Was that deploy actually authorized, or did someone push to prod
> unsupervised? And can we prove the answer to an auditor who doesn't trust our
> CI system?"

You have the evidence bundle covering that window (`bundle.json`) and the pinned
trust root (`trust-root.json`).

## Step 1 — Establish the evidence is genuine (2 min)

```bash
./verify.sh
# RESULT: PASS — 2 independent verifier(s) agree the bundle is authentic and intact.
```

A PASS means: this bundle was signed by AtlaSent's audit-issuing key, and not a
byte has been altered since. You are now reasoning over **trustworthy** data.
If it had FAILED, you would stop here — the records cannot be relied upon, and
*that* is itself a finding.

## Step 2 — Locate the decision in question

Open `bundle.json` and read `records[]`. Each entry carries a `decision_id` and
a `decision`. Find the record corresponding to the deploy (by `decision_id`,
correlated to your deploy/run id, or by the surrounding records' ordering and
timestamps). Inspect:

- `decision` — was it `allow`, or was it `deny` / `hold` / `escalate`?
- the record's bound context (action identity, actor, and any approval
  reference the export includes).

Because the record's `entry_hash` was recomputed and matched in Step 1, you know
this content is exactly what AtlaSent recorded at decision time — it cannot have
been edited after the fact.

## Step 3 — Answer the question

- **If `decision == "allow"`** with a bound human approval: the deploy *was*
  authorized; the approval artifact identifies who authorized it. The Friday
  deploy was supervised — here is the cryptographically-intact record.
- **If `decision == "deny"` / `"hold"`** but the deploy still happened: now you
  have a *real* finding — an action executed against a non-`allow` decision.
  That is a gap between authorization and execution to investigate (and exactly
  the kind of thing runtime-execution verification is meant to catch).
- **If there is no record for the deploy at all:** the action was not gated by
  AtlaSent. Whether that is acceptable is a scoping question — but the *absence*
  is informative, and the surrounding chain's contiguity (Step 1) means a record
  wasn't silently deleted from this window.

## Step 4 — Hand it to a third party

The auditor or regulator does not have to trust your CI system, your word, or
even AtlaSent's running infrastructure. Hand them this directory and the pinned
public key. They run `./verify.sh`, get PASS, and read the same record you did.
The evidence stands on its own.

## What this workflow does *not* settle

- Whether the *policy* that allowed the deploy was the right policy (read the
  policy and the decision context).
- Whether the deployed artifact matched what was authorized (runtime-execution
  evidence — request it if your inquiry needs it).
- Whether there are relevant decisions outside this exported window
  (reconcile `chain_context` against the authority's chain head).

See [`04-threat-model.md`](04-threat-model.md) for the full boundary.

## Tampering drill (optional, recommended)

Convince yourself the check is real. Copy the bundle, change one character in a
record's `decision` from `deny` to `allow`, and re-verify:

```bash
cp bundle.json /tmp/forged.json
# edit /tmp/forged.json: flip a record's decision value
node verify.mjs /tmp/forged.json trust-root.json
# FAIL  record[N].entry_hash does not match recomputed content hash
```

A forger cannot change the record without breaking its hash, and cannot fix the
hash without breaking the chain, and cannot re-sign the chain without the
private key. That chain of "cannots" is the guarantee.
