# Changelog

## 2.3.0 — Unreleased — approval quorum contract parity

> **Correction (2026-05-05).** A caveat added earlier today claimed
> identity-attested approvals and quorum verification were not yet
> enforced on the deployed legacy evaluate entrypoint in
> `atlasent-api`. **That caveat was wrong.** The deployed entry is a
> thin shim that delegates to `handleEvaluate`, where the new gates
> were wired (atlasent-api PRs #291 / #294 / #296). The split was
> already collapsed by `4e502ae` on 2026-05-03 — before the
> approval-artifact phase started — so the new gates are enforced
> on the deployed entry today. See
> `atlasent-api/docs/adr/ADR-evaluate-path.md` (Status: **Resolved**)
> for the design record and the regression test that locks the shim
> form in place.
### Added

- `ApprovalQuorumV1`, `QuorumPolicy`, `QuorumRoleRequirement`,
  `QuorumIndependence`, `QuorumProof` — Pydantic mirrors of the
  wire-stable `approval_quorum.v1` schema published in
  `contract/schemas/approval-quorum.schema.json` and the TS SDK.
  Re-exported from `atlasent.*`. All `extra="forbid"`.
- 6 new tests in `tests/test_approval_artifact.py`:
  - parametrized over the 11 quorum fixtures in
    `contract/vectors/approval-quorum/`
  - policy round-trip + extra-field rejection
  - `required_count >= 1` enforced
  - `quorum_hash` pattern enforced
  - per-entry artifact `extra="forbid"` propagates through the
    quorum container

### No new behavior

This release is contract parity only. Quorum verification is
server-side inside `/v1-evaluate`; the SDK exposes the wire types
so callers can construct a quorum payload before submitting.

The locked invariant: quorum does NOT relax artifact verification.
Every approval inside a quorum package must first pass the locked
single-approval verifier (artifact signature + identity assertion +
every binding) before quorum-level policy is evaluated.

## 2.2.0 — 2026-05-05 — identity attestation contract parity

### Added

- `IdentityAssertionV1`, `IdentityAssertionBinding`, `IdentityIssuer`,
  `IdentitySubject` — Pydantic mirrors of the wire-stable
  `identity_assertion.v1` schema published in
  `contract/schemas/identity-assertion.schema.json` and the TS SDK.
  Re-exported from `atlasent.*`.
- `IdentityIssuerKey` + `IdentityTrustedIssuersConfig` — Pydantic
  shape of the `IDENTITY_TRUSTED_ISSUERS` env var, the second trust
  root the verifier consults (independent of
  `APPROVAL_TRUSTED_ISSUERS`). Includes `allowed_roles` and
  `allowed_environments` issuer-scope fields.
- `ApprovalArtifactV1.identity_assertion` (optional) — the artifact
  may now carry an independently-signed identity assertion. Required
  on the wire whenever `/v1-evaluate` calls the verifier with
  `requireIdentityAssertion: true` (i.e. when human approval is
  required); without it the server returns deny: `missing identity
  assertion`. The SDK keeps the field optional so shadow / preflight
  flows that don't verify can still construct artifacts.

### No new behavior

This release is contract parity only — no client-side enforcement
was added. The verifier remains in the Deno edge functions; the
Python SDK only carries the assertion. Quorum / multi-approval is
explicitly out of scope.

## 2.1.0 — 2026-05-05 — approval artifact contract parity

### Added

- `ApprovalArtifactV1`, `ApprovalReviewer`, `ApprovalIssuer`,
  `ApprovalReference`, `PermitApprovalBinding`, `PrincipalKind` —
  Pydantic mirrors of the wire-stable types published in
  `contract/schemas/approval-artifact.schema.json` and the TS SDK
  (`approvalArtifact.ts`). Re-exported from `atlasent.*`.
- `ApprovalTrustedIssuersConfig` + `TrustedIssuerKey` — Pydantic
  shape of the `APPROVAL_TRUSTED_ISSUERS` env var read server-side
  by `/v1-evaluate`. Server config only; the SDK exposes the model
  so operators can construct / lint / round-trip the JSON in CI.
  Includes the `allowed_action_types`, `allowed_environments`, and
  `required_role` issuer-scope fields.
- `EvaluateRequest.approval` (`ApprovalReference`) and
  `EvaluateRequest.require_approval` — carried on
  `POST /v1-evaluate` so callers can submit a signed approval and
  hard-assert the gate even when the action_type-prefix heuristic
  doesn't match server-side.
- `EvaluateRequest.resource_id` and `EvaluateRequest.amount` —
  documented inputs to the canonical action hash that approval
  artifacts cover.
- `EvaluateResult.permit_approval` (`PermitApprovalBinding`) —
  surfaces the cryptographic linkage minted at issuance. Populates
  from BOTH wire shapes the server may emit: `permit.approval`
  nested per PermitV2 (atlasent-console) and top-level
  `permit_approval` (atlasent-api).
- `VerifyRequest.require_approval` — caller assertion that the
  consume must produce a permit row with a populated approval
  binding; missing binding triggers `APPROVAL_LINKAGE_MISSING`.
- `VerifyResult.consumed` and `VerifyResult.approval` — surface
  whether the atomic consume burned the permit (critically `True`
  on `APPROVAL_LINKAGE_MISSING` — the permit is gone, do not retry)
  and the persisted approval binding.
- `AtlaSentClient.evaluate(...)` and `AsyncAtlaSentClient.evaluate(...)`
  gained `resource_id`, `amount`, `approval`, `require_approval`
  kwargs.
- `AtlaSentClient.verify(...)` and `AsyncAtlaSentClient.verify(...)`
  gained `require_approval` kwarg.
- 28 new tests in `tests/test_approval_artifact.py` mirror the
  TS-SDK vector suite — all eight contract fixtures
  (`valid`, `expired`, `wrong-hash`, `agent-reviewer`,
  `missing-role`, `untrusted-issuer`, `wrong-signature`, `replay`)
  load via `ApprovalArtifactV1`; wire-shape parity checks for
  `EvaluateRequest`, `VerifyRequest`, `EvaluateResult`,
  `VerifyResult`; trusted-issuer config round-trip.

### No new behavior

This release is contract parity only — no server-side semantics or
client-side enforcement was added. The verifier remains in the Deno
edge functions; the Python SDK only carries the artifact and surfaces
the binding on responses. Identity attestation and quorum are
explicitly out of scope here and tracked separately.

## 2.0.0 — 2026-04-30 — wire-format reconciliation (BREAKING)

## 2.0.0 — 2026-04-30 — wire-format reconciliation (BREAKING)

### Wire format

The SDK now serializes the **canonical** request shape consumed by the
deployed `atlasent-api/.../v1-{evaluate,verify-permit}/handler.ts`:

- `POST /v1-evaluate` body is `{ action_type, actor_id, context }`
  (previously `{ action, agent, context, api_key }`).
- `POST /v1-verify-permit` body is `{ permit_token, action_type,
  actor_id }` (previously `{ decision_id, action, agent, context,
  api_key }`).
- `api_key` is no longer echoed in the request body — the server
  reads it from the `Authorization: Bearer ...` header (which the
  client has always sent).

This is the **breaking** part: an SDK upgrade requires the
counterpart `atlasent-api` deployment to have the handler.ts entry
wired (the swap landed in `atlasent-api#190`). Older deployments
that still read the legacy wire shape will return
`400 BAD_REQUEST: missing 'action_type'` until they pick up the
handler.ts entry.

### Backward-compat (no silent break for SDK callers)

- **Construction with legacy keyword names keeps working:**
  `EvaluateRequest(action="...", agent="...", api_key="...")` and
  `VerifyRequest(decision_id="...", action="...", agent="...",
  api_key="...")` are accepted via pydantic
  `validation_alias=AliasChoices(...)` and emit
  `DeprecationWarning` so callers can surface the migration in their
  test suites. The actionable warning lands on the construction
  site.
- **Result objects still expose legacy attributes:**
  `result.permitted`, `result.decision_id`, `result.audit_hash`,
  `result.timestamp`, `result.reason` (on `EvaluateResult`),
  `result.verified`, `result.permit_hash` (on `VerifyResult`) are
  populated alongside their canonical counterparts. Existing readers
  see no change.
- **Legacy server responses are still parsed:** the model validator
  accepts both `{permitted, decision_id, ...}` and
  `{decision, permit_token, request_id, ...}` shapes, so an SDK
  upgrade ahead of an atlasent-api upgrade still parses cleanly.

### Added — canonical attributes on result objects

- `EvaluateResult.decision`: `Literal["allow", "deny", "hold",
  "escalate"]` — replaces the bool that used to live under the same
  name. (In the fail-closed `evaluate()` surface this is always
  `"allow"` when the result is returned; the other values appear
  when constructing or parsing the model directly.)
- `EvaluateResult.permit_token`, `request_id`, `expires_at`,
  `denial: { reason, code }`.
- `VerifyResult.valid: bool`, `outcome: Literal["allow", "deny"]`,
  `verify_error_code: str | None` — surface the canonical handler.ts
  shape so SDK callers can branch on `verify_error_code` (e.g.
  `PERMIT_EXPIRED`, `PERMIT_REVOKED`, `RATE_LIMITED`) without parsing
  free-form `reason` strings.

### Changed — `EvaluateResult.decision` is no longer a `bool`

The single non-additive break for code that READ `result.decision`:
it is now `"allow"` rather than `True`. The truthy check
(`if result.decision:`) keeps working; explicit `==` against `True`
or `False` does not. Migration is one keystroke per call site:

```diff
- if result.decision == True:
+ if result.decision == "allow":
```

The legacy boolean is preserved on `result.permitted` (`True` iff
`decision == "allow"`).

### Changed — `verify()` no longer sends `context` on the wire

The deployed verify handler does not consult the `context` field;
the client now omits it from the wire to keep the body honest. The
public `verify(...)` keyword argument still exists for backward
compat with callers — it is silently dropped. PR2 will add a
`DeprecationWarning` for non-empty `context` passed to `verify()`
specifically.

### Migration guide

Most callers need zero changes: the public `client.evaluate(...)`
and `client.verify(...)` methods already use canonical kwargs, and
result-attribute readers continue to work via the legacy mirror.

If you build models directly:

```diff
- EvaluateRequest(action="deploy", agent="bot", api_key="...")
+ EvaluateRequest(action_type="deploy", actor_id="bot")
```

```diff
- VerifyRequest(decision_id="dec_x", action="deploy", agent="bot")
+ VerifyRequest(permit_token="dec_x", action_type="deploy", actor_id="bot")
```

If you branch on `result.decision` as a bool, switch to the string
enum or read `result.permitted`.

## 1.6.0 — 2026-04-30

### Added

- **`AtlaSentDeniedError.outcome`** — discriminator that distinguishes
  permit-side denial reasons (D4 of `LAST_20_EXECUTION_PLAN`).
  Populated from `/v1-verify-permit` `outcome` and typed as
  `PermitOutcome` (`permit_consumed | permit_expired | permit_revoked
  | permit_not_found`). Predicates `is_revoked`, `is_expired`,
  `is_consumed`, `is_not_found` map directly to the operator runbook
  matrix in `docs/REVOCATION_RUNBOOK.md` (atlasent meta).

  Pre-existing callers are unaffected — `outcome` defaults to `None`
  and existing kwargs are unchanged. The error message and `reason`
  field still carry the raw outcome string for log debuggability.

  Unknown / future outcome strings normalize to `None` (rather than
  surfacing an unrecognized literal), so callers branching on
  `excinfo.value.outcome` won't accidentally match an outcome the
  SDK was built before.

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

## 1.5.0 — 2026-04-25

### Added

- **`list_audit_events()` and `create_audit_export()`.**

## 1.4.0 — 2026-04-23

### Added

- **`key_self()` — API-key self-introspection.**

## 1.3.0 — 2026-04-23

### Added

- **`rate_limit` field on every authed response.**

## 1.2.0 — 2026-04-23

### Added

- **`AtlaSentError.request_id`.**

## 1.1.0 — 2026-04-23

### Added

- **`atlasent.protect(...)` — the one-call authorization primitive.**

## 1.0.0 — 2026-04-17

First stable release. Public exports in `atlasent/__init__.py` are
the supported v1 surface; pin to `>=1.0.0,<2.0.0`.

### Added

- Cross-language `RELEASE_NOTES.md` covering the v1.0.0 surface for
  both `atlasent` and `@atlasent/sdk`.
