# Release Notes

## v2.0.0 — Wire-format reconciliation + dual-shape compat bridges (TS + Py)

**Release date:** 2026-05-05

Both SDKs move to the canonical wire format served by `atlasent-api/handler.ts`.
The high-level `protect()` / `evaluate()` / `verify()` call signatures are
**unchanged** — the wire translation is internal. Dual-shape compat bridges
accept legacy field names and emit deprecation warnings so callers can migrate
on their own schedule.

### TypeScript (`@atlasent/sdk@2.0.0`)

- **Wire format (BREAKING at the wire level):** `POST /v1-evaluate` body is now
  `{ action_type, actor_id, context }` (was `{ action, agent, context, api_key }`).
  `POST /v1-verify-permit` body is `{ permit_token, action_type, actor_id }`.
  `api_key` is no longer echoed — the server reads the `Authorization: Bearer`
  header (always sent).
- **Dual-shape input bridge (`src/compat.ts`):** `normalizeEvaluateRequest()`
  accepts both `{ action, agent }` (legacy) and `{ action_type, actor_id }`
  (canonical), emitting `console.warn` on legacy field use.
- **Dual-shape response bridge:** `normalizeEvaluateResponse()` accepts both
  `{ permitted, decision_id }` (legacy server) and `{ decision, permit_token }`
  (canonical), so an SDK upgrade ahead of an `atlasent-api` deploy still parses.
- Both shims removed in v3.0.0. Migrate to `action_type` / `actor_id` before then.

### Python (`atlasent==2.2.0`)

Cumulative across three releases in the 2.x line:

- **2.0.0 — Wire-format reconciliation (BREAKING):** Same field renames as TS.
  Backward-compat via `validation_alias` / `AliasChoices`; legacy mirror
  attributes (`result.permitted`, `result.decision_id`, etc.) preserved.
  `EvaluateResult.decision` is now `"allow"` (string, not `True` bool);
  `result.permitted` preserves the legacy bool.
- **2.1.0 — Approval artifact contract parity:** `ApprovalArtifactV1`,
  `ApprovalReviewer`, `ApprovalIssuer`, `ApprovalReference`,
  `PermitApprovalBinding`, `PrincipalKind` — Pydantic mirrors of
  `contract/schemas/approval-artifact.schema.json`. `EvaluateRequest.approval`,
  `EvaluateRequest.require_approval`, `VerifyRequest.require_approval`,
  `EvaluateResult.permit_approval`, `VerifyResult.consumed`,
  `VerifyResult.approval` added.
- **2.2.0 — Identity attestation contract parity:** `IdentityAssertionV1`,
  `IdentityAssertionBinding`, `IdentityIssuer`, `IdentitySubject`,
  `IdentityTrustedIssuersConfig` — Pydantic mirrors of `identity-assertion.v1`
  schema. `ApprovalArtifactV1.identity_assertion` (optional) added.

### Upgrade

```bash
npm install @atlasent/sdk@2.0.0
pip install atlasent==2.2.0
```

### Breaking changes

Requires a coordinated `atlasent-api` deploy (`handler.ts` wired for
`/v1-evaluate` and `/v1-verify-permit`). Older deployments return
`400 BAD_REQUEST: missing 'action_type'` until the handler is updated.

Python-only: `EvaluateResult.decision` changes from `True`/`False` to
`"allow"`/`"deny"`. The `.permitted` attribute preserves the legacy bool.

---

## v1.6.0 — `AtlaSentDeniedError.outcome` discriminator (TS + Py)

**Release date:** 2026-04-30

Adds a typed `outcome` discriminator to `AtlaSentDeniedError` so callers
can branch on the permit-side denial reason without parsing the
`reason` string. Mirrors the operator runbook matrix in
`atlasent/docs/REVOCATION_RUNBOOK.md`.

### TypeScript (`@atlasent/sdk@1.6.0`)

- **`AtlaSentDeniedError.outcome`** — typed `PermitOutcome`
  (`"permit_consumed" | "permit_expired" | "permit_revoked" |
  "permit_not_found"`), populated from `/v1-verify-permit` `outcome`.
  Predicates `isRevoked`, `isExpired`, `isConsumed`, `isNotFound`
  surface the same information as named flags. Unknown / future
  outcome strings normalize to `undefined` — callers branching on
  `err.outcome` won't accidentally match an outcome the SDK predates.

  ```ts
  import atlasent, { AtlaSentDeniedError } from "@atlasent/sdk";

  try {
    await atlasent.protect({ agent: "bot", action: "deploy" });
  } catch (err) {
    if (err instanceof AtlaSentDeniedError) {
      if (err.isRevoked) notifySecurity("permit revoked mid-flight");
      else if (err.isExpired) await retryAfterRefresh();
      else throw err;
    }
  }
  ```

### Python (`atlasent==1.6.0`)

- **`AtlaSentDeniedError.outcome`** — typed `PermitOutcome`
  (`permit_consumed | permit_expired | permit_revoked |
  permit_not_found`) with companion `is_revoked`, `is_expired`,
  `is_consumed`, `is_not_found` predicates. Defaults to `None` for
  pre-existing callers and for unknown future outcome strings.

  ```python
  try:
      atlasent.protect(agent="bot", action="deploy")
  except AtlaSentDeniedError as exc:
      if exc.is_revoked:
          notify_security("permit revoked mid-flight")
      elif exc.is_expired:
          retry_after_refresh()
      else:
          raise
  ```

### Breaking changes

None — purely additive. `outcome` defaults to `None` / `undefined`,
existing kwargs / init fields are unchanged, and the error message
plus `reason` field still carry the raw outcome string for log
debugability.

### Upgrade notes

```bash
npm install @atlasent/sdk@1.6.0
pip install atlasent==1.6.0
```

---

## v2.0.0-alpha.1 / 2.0.0a1 — Pillar 8 bulk-revoke (TS + Py)

**Release date:** 2026-04-29

### What's new

**`bulkRevoke()` / `bulk_revoke()` — Pillar 8 Temporal bulk-revoke.**
New method on both clients that bulk-revokes all active permits for a
Temporal workflow run via `POST /v2/permits:bulk-revoke`:

```ts
// TypeScript
await client.bulkRevoke({
  workflowId: "deploy-wf-abc",
  runId: "run-00000000-...",
  reason: "emergency shutdown",
  revokerId: "ops-bot",          // optional
});
// → BulkRevokeResponse { revoked_count, workflow_id, run_id }
```

```python
# Python
result = client.bulk_revoke(
    workflow_id="deploy-wf-abc",
    run_id="run-00000000-...",
    reason="emergency shutdown",
    revoker_id="ops-bot",        # optional
)
# → BulkRevokeResponse(revoked_count=..., workflow_id=..., run_id=...)
```

`revoked_count: 0` is not an error — permits may have already expired
or been consumed before the revoke signal fires. The method is keyed
on the Temporal `run_id` so a single call closes the entire permit set
for that workflow execution.

**Wire contract** — `POST /v2/permits:bulk-revoke`. JSON Schema files
in `contract/schemas/v2/bulk-revoke-{request,response}.schema.json`.
Full OpenAPI entry in `contract/openapi-v2.yaml` with `temporal` tag.

**New types exported:**
`BulkRevokeRequest`, `BulkRevokeResponse` (both languages).

### Temporal workflow helpers updated (preview)

`atlasent-temporal-preview` / `@atlasent/temporal-preview` (PRs #90
/ #89) have been updated in lockstep:

- `bulk_revoke_atlasent_permits` / `bulkRevokeAtlaSentPermits`
  activities now make a real HTTP call via `AtlaSentV2Client` /
  `V2Client` (read from `ATLASENT_API_KEY` env var on the worker).
- New factory `make_bulk_revoke_activity(client)` /
  `createBulkRevokeActivity(client)` for dependency-injection when
  the worker already holds a pre-built client.
- `BulkRevokeNotImplementedError` is preserved — now signals
  "missing API key" rather than "missing server endpoint".

### Packages

| Language   | Package                              | Version           |
|------------|--------------------------------------|-------------------|
| Python     | `atlasent-v2-alpha`                  | `2.0.0a1`         |
| TypeScript | `@atlasent/sdk-v2-alpha`             | `2.0.0-alpha.1`   |

### Upgrade

```bash
pip install "atlasent-v2-alpha==2.0.0a1"
npm install @atlasent/sdk-v2-alpha@2.0.0-alpha.1
```

---

## v2.0.0-alpha.0 / 2.0.0a0 — v2 alpha (TS + Py)

**Release date:** 2026-04-27

The first publishable v2 surface, gated behind `-alpha` semantics:
breaking changes are still on the table between alpha releases.

### Packages

| Language   | Package                              | Install                                                |
|------------|--------------------------------------|--------------------------------------------------------|
| Python     | `atlasent-v2-alpha` `2.0.0a0`        | `pip install atlasent-v2-alpha`                        |
| TypeScript | `@atlasent/sdk-v2-alpha` `2.0.0-alpha.0` | `npm install @atlasent/sdk-v2-alpha@alpha` |

Both packages install cleanly **alongside** the v1 packages
(`atlasent`, `@atlasent/sdk`). The v1 surface is unchanged and remains
stable at v1.x.

### What's in v2-alpha

**Pillar 9 primitives** — deterministic JSON canonicalization and
SHA-256 hashing identical with v1's `canonical_json` /
`canonicalJSON`, plus wire-mirror types for every v2 schema in
`contract/schemas/v2/`.

**HTTP methods** on `V2Client` (TS) / `AtlaSentV2Client` (Py):

- `consume(permitId, payloadHash, executionStatus, executionHash?)`
  → `ConsumeResponse`.
- `verifyProof(proofId)` / `verify_proof(proof_id)` →
  `ProofVerificationResult`.
- `evaluateBatch(requests)` / `evaluate_batch(requests)` →
  `EvaluateBatchResponse`.
- `subscribeDecisions({ lastEventId?, signal? })` /
  `subscribe_decisions(*, last_event_id=None)` → async iterable
  of `DecisionEvent`.

### Cross-language parity

`canonicalize_payload` / `canonicalizePayload` produces byte-identical
output across Python and TypeScript on every test vector in
`contract/schemas/v2/`.

---

## v1.5.0 — Audit listing, signed exports, offline verification

**Release date:** 2026-04-25

Closes the long-standing `/v1-audit` parity gap.

### Upgrade notes

```bash
npm install @atlasent/sdk@1.5.0
pip install atlasent==1.5.0
```

---

## Previous releases

- **v1.5.0** (2026-04-25) — Audit listing, signed exports, offline
  verification on both SDKs.
- **v1.4.0** (2026-04-23) — `keySelf()` API-key self-introspection on
  both SDKs.
- **v1.3.0** (2026-04-23) — `rateLimit` / `rate_limit` on every
  authed response.
- **v1.2.0** (2026-04-23, TS only) — `@atlasent/sdk/hono` Hono
  middleware. Python parity follows.
- **v1.1.0** (2026-04-22 TS / 2026-04-23 Python) — `protect()`
  fail-closed authorization primitive.
- **v1.0.0** (2026-04-17) — first stable release of both SDKs.

See `python/CHANGELOG.md` and `typescript/CHANGELOG.md` for the full
per-version detail.
