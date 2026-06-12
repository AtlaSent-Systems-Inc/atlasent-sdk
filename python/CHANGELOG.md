# Changelog

## Unreleased

### Added

- `EvaluateResult.deny_code` and `AtlaSentDenied.deny_code` /
  `AtlaSentDeniedError.deny_code` — the stable machine code naming *why* a
  non-allow decision was reached (e.g. `"SNAPSHOT_REQUIRED"`). `None` on
  `allow`. Branch on this instead of parsing the human-readable `reason`.
  The denial's string form now includes the code (`Action denied: deny
  [SNAPSHOT_REQUIRED] — …`).
- `atlasent.DenyCode` (constant registry of documented deny codes, incl.
  `HUMAN_APPROVAL_REQUIRED`) and `atlasent.requires_human_approval(code)`.
  Plus `AtlaSentDenied.is_human_approval_required` — route a denied action
  into an approval queue instead of treating it as a hard refusal. The wire
  `deny_code` stays an open string; the registry is convenience, not a
  closed enum. Companion to the atlasent-api per-class `requires_human_approval`
  gate.

### Fixed

- Canonical denials now capture the deny metadata correctly. `handler.ts`
  emits **top-level** `deny_code` / `deny_reason`, but the client previously
  read only the nested `denial.{reason,code}` shape — so canonical denials
  surfaced with an empty `reason` and no code. The client + model now read
  both shapes and normalize them into `denial`, `reason`, and `deny_code`.

### Documentation

- README: the Quickstart `protect()` example now passes the required
  `state_snapshot`, and a new "State snapshots (required)" section explains
  that action classes default to `requires_state_snapshot = true` — omitting
  the snapshot returns a `SNAPSHOT_REQUIRED` deny (surfaced as
  `AtlaSentDeniedError`). `state_snapshot` is a top-level argument, not part
  of `context`.
## 2.17.0 -- 2026-06-10 -- SMS OTP + Usage Metering clients

### Added

- **`SmsOtpClient`** — new client for SMS OTP step-up authentication.
  Wraps `POST /v1-sms-otp/send` and `POST /v1-sms-otp/verify`. JWT session
  auth only (not API key).

  ```python
  from atlasent.sms_otp import SmsOtpClient

  otp = SmsOtpClient(client)
  result = otp.send(phone_e164="+15551234567", action_context="break_glass")
  verification = otp.verify(otp_id=result["otp_id"], code="123456")
  assert verification["valid"]
  ```

  Supported `action_context` values: `"break_glass"`, `"api_key_create"`,
  `"governance_hold_approve"`.

- **`UsageMeteringClient`** — new client for listing billable evaluation
  records and fetching aggregated usage summaries. Requires scope
  `usage:read`. Wraps `GET /v1-usage-metering` and
  `GET /v1-usage-metering/summary`.

  ```python
  from atlasent.usage_metering import UsageMeteringClient

  metering = UsageMeteringClient(client)
  page = metering.list(limit=100, decision="allow")
  summary = metering.summary(period="month")
  print(summary["total_evaluations"])
  ```

- Both clients are exported from `atlasent` directly:
  `from atlasent import SmsOtpClient, UsageMeteringClient`.

---

## 2.16.0 -- 2026-06-04 -- evaluation_profile + override fields

### Added

- **`EvaluateRequest.evaluation_profile`** — optional
  `Literal["basic", "standard", "advanced", "enterprise"] | None` field.
  Pass `"basic"` for pilot integrations that don't supply a state snapshot;
  snapshot enforcement is skipped while policy, risk envelope, and audit
  all still run. Unknown values fall back to `"standard"` server-side.

  ```python
  result = client.evaluate(
      EvaluateRequest(
          action_type="production.deploy",
          actor_id="github-actions",
          evaluation_profile="basic",   # pilot-safe: no snapshot required
      )
  )
  ```

- **`EvaluateRequest.override`** — optional `dict[str, Any] | None` for
  emergency overrides of snapshot hard blocks. Only evaluated when
  `evaluation_profile` is `"advanced"` or `"enterprise"`. The
  `authority_actor_id` must hold `override:execute` scope and differ from
  `actor_id`.

  ```python
  result = client.evaluate(
      EvaluateRequest(
          action_type="production.deploy",
          actor_id="deploy-bot",
          evaluation_profile="advanced",
          state_snapshot={"source": "ci", "payload": {"tests_passed": False}},
          override={
              "version":            "override.v1",
              "authority_actor_id": "ops-lead-uuid",
              "reason":             "Tests failed due to flaky test infra; manually verified",
              "time_bound_seconds": 900,
          },
      )
  )
  ```

---

## 2.15.0 -- 2026-06-03 -- state_snapshot field + SNAPSHOT_REQUIRED error handling

### Added

- **`EvaluateRequest.state_snapshot`** (`atlasent.models`) — optional `dict[str, Any]`
  field for attaching a system state snapshot to evaluate calls. Required when the
  action class has `requires_state_snapshot=True`. Omitting on a required class
  returns `decision="deny"` with `deny_code="SNAPSHOT_REQUIRED"`.

  ```python
  result = client.evaluate(
      EvaluateRequest(
          action_type="production.deploy",
          actor_id="github-actions",
          state_snapshot={
              "source":      "github-actions",
              "source_kind": "trusted",
              "complete":    True,
              "payload": {
                  "commit_sha":   os.environ["GITHUB_SHA"],
                  "workflow_ref": os.environ.get("GITHUB_WORKFLOW_REF"),
              },
          },
      )
  )

  if result.decision == "deny" and result.denial and result.denial.code == "SNAPSHOT_REQUIRED":
      # Add state_snapshot to your evaluate call for this action_type.
      pass
  ```

---

## 2.14.0 -- 2026-06-03 -- License verification (self-hosted / air-gapped)

### Added

- **`LicenseStatus`** (`atlasent.models`) — Pydantic model for `GET /v1/license`
  responses. Fields: `status` (`"active" | "grace" | "expired" | "revoked"`),
  `org_slug`, `posture` (`"self_hosted" | "air_gapped"`), `expires_at`,
  optional `grace_until`, `features` list, and optional `eval_limit` /
  `seat_limit` capacity integers.

- **`LicenseVerifyResult`** (`atlasent.models`) — Pydantic model for
  `POST /v1/license/verify` responses. Fields: `valid` (bool), optional
  `org_slug`, optional `expires_at`, optional `error` (machine-readable code).

- **`AtlaSentClient.get_license()`** — calls `GET /v1/license`; returns a
  fully-validated `LicenseStatus` (with `rate_limit` attached).

- **`AtlaSentClient.verify_license(blob)`** — calls `POST /v1/license/verify`;
  returns a fully-validated `LicenseVerifyResult`. A `valid=False` result is
  **not** raised — inspect the returned object.

Both `LicenseStatus` and `LicenseVerifyResult` are re-exported from the
top-level `atlasent` package.

---

## 2.13.0 -- 2026-05-28 -- Trust-root V1 (vendor snapshot, background refresh, fail-closed expiry)

### Added

- **`TrustRootManager`** (`atlasent.trust_root`) — vendor snapshot + background
  refresh implementing ADR-005 D2/D3/D4:
  - Loads `vendor/trust-root/` at startup via `_load_vendor_snapshot()`.
  - Refreshes from `https://keys.atlasent.io/.well-known/` every 4 hours
    (floor: 5 min) using a thread-safe `threading.Timer`.
  - `get_global_trust_root_manager()` — process-singleton accessor.
  - `check_expiry()` — returns `"ok" | "half_life" | "expired"`; emits
    `logger.warning` once per process at half-life and expiry.

- **Global auto-inject (B2.3):** `verify_bundle()` automatically uses
  `get_global_trust_root_manager().get_snapshot()` when no `trust_root`
  argument is supplied.

- **`BundleVerificationError`** (new exception, `atlasent.exceptions`) —
  extends `AtlaSentDeniedError`; carries `reason`, `snapshot_valid_until`,
  `snapshot_fetched_at`, `snapshot_source`, `kid`.

- **`PermitOutcome`** — new literal `"permit_signing_key_revoked"`.
- **`AtlaSentDeniedError.is_signing_key_revoked`** convenience property.

### Breaking change (B2.4)

`verify_audit_bundle()` now **raises** `BundleVerificationError` on trust
failures instead of returning a falsy result. Callers must migrate to:

```python
try:
    verify_audit_bundle(bundle, keys)
except BundleVerificationError as err:
    ...  # err.reason, err.snapshot_valid_until, etc.
```

Pass `allow_expired_snapshot=True` to opt out for air-gap environments.

### Tests

- `tests/test_trust_root_b31_smoke.py` — 9 bootstrap smoke tests.
- `tests/test_trust_root_b32_refresh.py` — 5 refresh integration tests
  using `unittest.mock.patch("urllib.request.urlopen")`.

---

## 2.12.0 -- 2026-05-28 -- SSO, access-governance-log, and evidence-bundle sub-clients wired into AtlaSentClient

### Added

- **`client.sso`** (`SsoClient`) — fluent sub-client for SSO connection management:
  - `list_connections()`, `get_connection(id)`, `create_connection(**kwargs)`,
    `update_connection(id, **kwargs)`, `delete_connection(id)`,
    `activate_connection(id)`, `deactivate_connection(id)`
  - JIT rule management: `list_jit_rules(conn_id)`, `create_jit_rule(conn_id, **kwargs)`,
    `patch_jit_rule(conn_id, rule_id, **kwargs)`, `delete_jit_rule(conn_id, rule_id)`
  - SSO enforcement and readiness: `enforce(org_id, **kwargs)`, `get_status(org_id)`

- **`client.access_governance_log`** (`AccessGovernanceLogClient`) — paginated access
  governance event log:
  - `list(**kwargs)` — `GET /v1/access-governance-log` with optional `limit`, `cursor`,
    `event_type`, `actor_id`, `from_`, `to` filters

- **`client.evidence_bundles`** (`EvidenceBundlesClient`) — compliance evidence bundle
  sub-client (wraps the existing `atlasent.evidence_bundle` standalone functions):
  - `list(**kwargs)`, `create(incident_id, **kwargs)`, `get(bundle_id)`,
    `download(bundle_id, format="json")`

- **`client.api_key`** and **`client.base_url`** public read-only properties on
  `AtlaSentClient` (previously only accessible as `_api_key` / `_base_url`).

### Tests

- 42 new unit tests across `tests/test_sso_client.py` and
  `tests/test_access_governance_log.py` — covers all endpoints, query-param
  forwarding, error handling, and empty-body responses. Coverage remains above 95%.

## 2.11.0 -- 2026-05-27 -- auth helpers, SCIM sub-client, evidence-bundle sub-client

### Added

- **`atlasent.auth`** module — token management and multi-IdP refresh helpers:
  - `refresh_token(client, refresh_token)` — `POST /v1/auth/token/refresh`
  - `refresh_with_idp(client, idp_id, refresh_token)` — refresh against a
    named SSO connection (`POST /v1/auth/idp/{idpId}/token/refresh`)
  - `list_idp_connections(client)` — `GET /v1/auth/idp-connections`

- **`atlasent.scim_client`** module — fluent SCIM 2.0 provisioning sub-client
  mirroring the TypeScript `client.scim.*` surface:
  - `ScimClient(client)` — exposes `.users` and `.groups` sub-clients
  - `ScimUsersClient`: `list`, `create`, `update`, `delete`
  - `ScimGroupsClient`: `list`, `create`, `delete`

- **`atlasent.evidence_bundle`** module — compliance evidence bundle helpers:
  - `create_evidence_bundle(client, org_id, **kwargs)`
  - `get_evidence_bundle(client, org_id, bundle_id)`
  - `download_evidence_bundle(client, org_id, bundle_id, format)`

- **`DecisionValue` type alias** — `Literal["allow", "deny", "hold", "escalate"]`,
  the canonical four-value decision type mirroring the TypeScript `Decision` type.
  Exported from the `atlasent` top-level namespace.

- **`Permit.permit_expires_at: str | None`** — new field mirroring TypeScript
  `permitExpiresAt`. Populated from the server's `expires_at` field in `protect()`.
  `None` when the server does not return an expiry.

- **`EvaluateResult.reasons: list[str]`** — new field mirroring TypeScript
  `reasons: string[]`. Populated from the wire array when present; when the server
  returns only a singular `reason` string the SDK wraps it in a one-element list
  for backward compatibility.

- **`atlasent.replay` module** — offline evidence-bundle verifier:
  - `verify_evidence_bundle(bundle) -> EvidenceVerificationResult` — verifies an
    evidence bundle dict offline without a backend round-trip. Checks required
    fields, `status == 'ready'`, and SHA-256 root hash integrity when a
    `hash_chain` is present.
  - `EvidenceVerificationResult(valid, permit_id, bundle_id, reason)` — result
    dataclass returned by `verify_evidence_bundle`.
  - Both `verify_evidence_bundle` and `EvidenceVerificationResult` are exported
    from the `atlasent` top-level namespace.

### Notes

- **Retries (Python parity note):** The Python client already retries transient
  errors with exponential back-off. No new Python-specific retry change landed in
  2.11.0 — the retry-with-jitter enhancement documented in the TypeScript changelog
  is TypeScript-only for this release.

## Unreleased

### Packaging

- Normalized licensing artifacts before publish:
  - `python/pyproject.toml` now declares `Apache-2.0` to match `python/LICENSE`.
  - `atlasent-temporal-preview` now declares `Apache-2.0` in
    `python/atlasent_temporal_preview/pyproject.toml`.
  - Added `python/atlasent_temporal_preview/LICENSE` with Apache-2.0 text.

## 2.7.0 -- 2026-05-24 -- risk envelope Phase C

### Added

- **`atlasent.models.EvaluateRiskEnvelopeFactor`** — Pydantic model for one
  factor contribution: `{ factor, value, weight, reason }`.

- **`atlasent.models.EvaluateRiskEnvelope`** — Pydantic model for the
  top-level risk envelope block present on all responses from engine version
  `wire-v1@1.0.0+`:
  - `weighted_score: float` — composite score in [0, 1]; ≥ 0.70 triggers hold
  - `engine_decision` — policy engine decision *before* envelope promotion
  - `envelope_decision` — decision resolved by the envelope
  - `promoted: bool` — `True` when envelope raised the engine decision
  - `hard_blocks: list[str]` — deny codes that blocked unconditionally
  - `factors: list[EvaluateRiskEnvelopeFactor]` — per-factor breakdown;
    only populated when `explain=True` was passed on the request

- **`EvaluateResult.risk_envelope: EvaluateRiskEnvelope | None`** — populated
  from the Phase C inline wire field. `None` on pre-Phase-C server responses.

- **`EvaluateRequest.explain: bool | None`** — when `True`, the server
  populates `risk_envelope.factors`. Omit for smaller payloads.

- New exports from `atlasent`: `EvaluateRiskEnvelope`, `EvaluateRiskEnvelopeFactor`.

### Usage

```python
from atlasent import AtlaSentClient

client = AtlaSentClient(api_key="ask_live_...")
result = client.evaluate(
    action_type="approve_payment",
    actor_id="user_01",
    explain=True,
)

if result.risk_envelope:
    print(result.risk_envelope.weighted_score)    # 0.723
    print(result.risk_envelope.promoted)          # True
    for f in result.risk_envelope.factors:
        print(f.factor, f.value, f.reason)
```

---

## 2.6.0 -- 2026-05-24 -- decision replay runtime (Python parity restore)

### Added

- **`AtlaSentClient.replay(*, evaluation_id)`** -- sync wrapper around
  `POST /v1/decisions/{id}/replay` (ADR-015 Phase C parity runtime).
  Re-evaluates a recorded decision against its originally-pinned
  policy bundle and engine version, and returns a `ReplayResponse`
  with the variance outcome. Side-effect-free server-side: no audit
  chain row is written and no permit is minted (ADR-016
  `mode: "replay"` sentinel).

- **`atlasent.models.ReplayResponse`** -- Pydantic model with the
  variance kind, original-and-replayed decisions, engine-version
  metadata, envelope-verification state, and rate-limit state.

- **`atlasent.models.ReplayVarianceKind`** -- 7-value `Literal` union
  covering both raw wire values (`NONE`, `DECISION_CHANGED`,
  `ENVELOPE_DRIFT`) and SDK-canonical mappings (`POLICY_DRIFT`,
  `CHAIN_TAMPER`, `ENGINE_DRIFT`, `BUNDLE_MISSING`).

- **`tests/test_client_replay.py`** -- 10 tests pinning the wire
  contract: all variance kinds, `DECISION_CHANGED → POLICY_DRIFT`
  normalization, forward-compat default-to-`NONE` for unrecognized
  variance strings, `409 replay_not_eligible → ENGINE_DRIFT /
  BUNDLE_MISSING` (returned, not raised), URL path + JSON body
  shape, `evaluation_id` URL-encoding.

### Variance semantics

| `variance_kind` | Meaning |
|---|---|
| `NONE` | Replay agrees with the original decision |
| `POLICY_DRIFT` | Same envelope, same bundle, different decision (typically rule non-determinism). Normalized from the wire `DECISION_CHANGED` value |
| `ENVELOPE_DRIFT` | Recorded envelope hash no longer matches the recomputed canonical hash; replay short-circuited |
| `CHAIN_TAMPER` | Audit-chain-v5 detector reports the engine_version binding was tampered |
| `ENGINE_DRIFT` | Original engine version retired beyond archival window, or absent from the registry |
| `BUNDLE_MISSING` | Original policy bundle was not pinned on the recorded evaluation |

### Fix-forward note

PR #275 (`feat(client): add client.replay() — ADR-015 Phase C parity
runtime`) added the **async** `AsyncAtlaSentClient.replay()` method
plus its imports in `async_client.py`, but its squash merge dropped 7
of 11 files from the PR -- including `python/atlasent/models.py`
(`ReplayResponse` / `ReplayVarianceKind`), `python/atlasent/client.py`
(sync `replay()`), `python/atlasent/__init__.py` (exports), and the
test file. The result was that `from atlasent import async_client`
raised `ImportError: cannot import name 'ReplayResponse' from
'atlasent.models'` on `main`, blocking every Python consumer.

This release restores the dropped pieces. The async surface that did
land in 275 is unchanged; the sync surface mirrors it exactly so
contract-vector conformance is symmetric across both runtimes.

---

## 2.5.0 -- 2026-05-22 -- governance agents read surface (parity with @atlasent/sdk 2.6.0)

### Added

- **`python/atlasent/governance_agents.py`** -- new module with Pydantic
  models ported from `typescript/src/governanceAgents.ts` (source of truth):
  - `GovernanceAgent` -- advisory agent registry entry.
    `authority_class == "advisory"` and `can_authorize == False` are
    structural invariants; the DB enforces them with a CHECK constraint.
  - `GovernanceAgentFinding` -- finding emitted by an agent run.
    `can_authorize == False` enforced the same way.
  - `GovernanceAgentEvaluation` -- agent run record (status, timings,
    findings count).
  - `AgentEvidenceRef` -- evidence artifact reference inside a finding.
  - Result dataclasses: `ListGovernanceAgentsResult`,
    `ListGovernanceFindingsResult`, `ListGovernanceEvaluationsResult`.
  - `highest_agent_finding_severity(findings)` -- helper that returns
    the highest severity string across a finding list
    (`blocker` > `high` > `medium` > `low` > `info`).

- **`AtlaSentClient.list_governance_agents()`** --
  `GET /v1/governance/agents`. Returns all advisory agents for the
  calling org.

- **`AtlaSentClient.list_governance_findings(*, change_id, agent_slug=None)`** --
  `GET /v1/governance/findings?change_id=...`. Returns findings for a
  governed change; optional `agent_slug` filter.

- **`AtlaSentClient.list_governance_evaluations(*, change_id, agent_slug=None)`** --
  `GET /v1/governance/evaluations?change_id=...`. Returns run records
  for a governed change; optional `agent_slug` filter.

- **`AsyncAtlaSentClient`** gains the same three methods as async parity.

- All seven types + helper re-exported from the `atlasent` top-level
  namespace and added to `__all__`.

### Doctrine

- Governance agents are **advisory-only**. No invocation endpoint is
  exposed in the SDK -- CI invocation is `atlasent-action`'s job (the
  `governance-agents` mode). The SDK surfaces only the read side.
- `can_authorize` is a literal `False` on both `GovernanceAgent` and
  `GovernanceAgentFinding` models, matching the TS SDK's
  `can_authorize: false` (not `boolean`).

## [unreleased] — 2026-05-18

### Platform-generation reframing (doc-only, no code change)

Mirrors the umbrella reframing in [`atlasent/CHANGELOG.md`](https://github.com/AtlaSent-Systems-Inc/atlasent/blob/main/CHANGELOG.md). Platform generations: **v1** = pilot + cash-flowing capability layer (this repo's V2_ROLLOUT.md is preserved with a normalization header and continues to apply); **v2** = full enterprise surface ([`atlasent/ENTERPRISE_V2_ROLLOUT.md`](https://github.com/AtlaSent-Systems-Inc/atlasent/blob/main/ENTERPRISE_V2_ROLLOUT.md)); **v3** = execution assurance. `V2-D#` identifiers retained; new decisions use `PROD-D#`. Package SemVer (e.g. `@atlasent/sdk@2.x`) is decoupled from platform generation labels per [`atlasent/VERSIONING_DOCTRINE.md`](https://github.com/AtlaSent-Systems-Inc/atlasent/blob/main/VERSIONING_DOCTRINE.md) doctrine 1.

## Unreleased

### Added

- **Contract test for ADR-0002 invariant I-6** -- `tests/test_policy_mutation_guard.py`
  scans `AtlaSentClient` and `AsyncAtlaSentClient` and fails CI if any
  method matches a governance-policy mutation shape. Test-only; no API
  surface change. See `atlasent-internal/architecture/ADR-0002` and
  atlasent-sdk#230.

## 2.4.0 — 2026-05-14 — canonical Deploy Gate action: `production.deploy`

### Added

- **`PRODUCTION_DEPLOY_ACTION` constant** -- exported from `atlasent`
  (value `"production.deploy"`). The new V1 canonical Deploy Gate
  action string, mirroring the TypeScript SDK's
  `PRODUCTION_DEPLOY_ACTION`.

### Changed

- **All quickstart examples and docstrings now use `"production.deploy"`** --
  top-level `README.md`, `python/README.md`, `python/examples/protect.py`,
  and the docstrings in `atlasent/__init__.py`, `atlasent/client.py`,
  `atlasent/async_client.py`, `atlasent/with_permit.py`, and
  `atlasent/authorize.py`. The underlying server-side canonical was
  renamed in atlasent-api PR #662 (`action_classes.slug`) and
  atlasent-console PR #432 (`protected_actions.key`). The server
  alias-tolerates the legacy `"deployment.production"` during the V1
  alias window, so callers that explicitly pass
  `action="deployment.production"` continue to work.

## 2.3.1 — Unreleased — permit observability surface + entrypoint canonicalization

### Canonical SDK surface (Tier 3 of pilot-readiness plan)

The SDK now pitches **three** primitives as canonical, each with a
distinct lifecycle. New code should pick one:

- `atlasent.protect()` — **fail-closed execution.** Use when the
  caller wants "no permit, no execution." Raises on `deny`,
  `hold`, `escalate`, or verification failure.
- `atlasent.evaluate()` — **raw decision primitive.** Use when the
  caller needs to inspect the four-value decision
  (`allow` / `deny` / `hold` / `escalate`).
- `atlasent.verify()` — **post-permit verification primitive**,
  for callers that already hold a permit token.

### Deprecated

- `atlasent.authorize()` and `AtlaSentClient.authorize()` /
  `AsyncAtlaSentClient.authorize()` -- the data-not-exception variant
  (returns `permitted: bool`). Migrate to `protect()` for
  fail-closed execution, or `evaluate()` to inspect the
  four-value decision.
- `atlasent.gate()` and `AtlaSentClient.gate()` /
  `AsyncAtlaSentClient.gate()` -- evaluate + verify in one call,
  returning an inspectable `GateResult`. Migrate to `protect()`
  for fail-closed execution, or `evaluate()` + `verify()` for the
  two-step inspectable shape.

All four deprecated entrypoints emit `DeprecationWarning` on use
and continue to work for the rest of the `atlasent@2` line. They
will be removed in `atlasent@3`. No wire-format change. No behavior
change for callers not using the deprecated functions.

### Async parity (AsyncAtlaSentClient)

The async client now ships full parity for the canonical permit
observability + lifecycle surface:

- `AsyncAtlaSentClient.get_permit(permit_id)`
- `AsyncAtlaSentClient.list_permits(*, status=, actor_id=, action_type=, from_=, to=, limit=, cursor=)`
- `AsyncAtlaSentClient.revoke_permit_by_id(permit_id, *, reason=None)`
- `AsyncAtlaSentClient.verify_permit_by_id(permit_id)`

Same shapes / semantics as the sync versions; documented as parity.

### Async deprecations

- `AsyncAtlaSentClient.revoke_permit()` -- legacy
  `POST /v1-revoke-permit`. Emits `DeprecationWarning`. Migrate to
  `revoke_permit_by_id()`.
- `AsyncAtlaSentClient.verify()` -- legacy
  `POST /v1-verify-permit`. Emits `DeprecationWarning`. Migrate to
  `verify_permit_by_id()`.

Brings the async surface to parity with the sync client's
deprecation state from this same release.

### Added — canonical REST migration for revoke / verify

- `AtlaSentClient.revoke_permit_by_id(permit_id, *, reason=None)` --
  calls `POST /v1/permits/{id}/revoke`. Returns the full updated
  `PermitRecord` with `status == 'revoked'` and `revoked_at` /
  `revoked_by` / `revoke_reason` populated, instead of the legacy
  `{revoked, permit_id}` envelope.
- `AtlaSentClient.verify_permit_by_id(permit_id)` -- calls
  `POST /v1/permits/{id}/verify`. Returns the unified verification
  envelope (`valid`, `verification_type='permit'`, `reason`,
  `verified_at`, `evidence`) plus the full `PermitRecord` preserved
  on `permit`. Pin to `valid` for new code.
- New types: `RevokePermitByIdResult`, `VerifyPermitByIdResult`,
  `PermitVerifyEvidence`.

### Deprecated

- `AtlaSentClient.revoke_permit()` and `RevokePermitResult` -- legacy
  `POST /v1-revoke-permit` (token-in-body). Migrate to
  `revoke_permit_by_id()`. Emits `DeprecationWarning` on use.
- `AtlaSentClient.verify()` and `VerifyResult` -- legacy
  `POST /v1-verify-permit` (token-in-body). Migrate to
  `verify_permit_by_id()`. Emits `DeprecationWarning` on use.

The legacy methods continue to work for the rest of the
`atlasent@2.x` line. Removed in `atlasent@3`.

### Added — permit observability surface

- `AtlaSentClient.get_permit(permit_id)` -- calls the canonical
  `GET /v1/permits/{permit_id}` REST endpoint. Returns
  `GetPermitResult(permit: PermitRecord, rate_limit)` with full
  lifecycle state (status, all timestamps, `revoked_at` /
  `revoked_by` / `revoke_reason`, bound `payload_hash` /
  `decision_id`).
- `AtlaSentClient.list_permits(status=, actor_id=, action_type=, from_=, to=, limit=, cursor=)`
  -- calls `GET /v1/permits` with cursor pagination.
- New types: `PermitRecord`, `GetPermitResult`, `ListPermitsResult`.

### Notes

- TypeScript SDK parity for the canonical permit observability
  surface (atlasent-sdk#176 on the TS side).
- `revoke_permit()` continues to call the legacy
  `/v1-revoke-permit` endpoint. Migrating it (and `verify`) to the
  canonical REST surface is a separate follow-on with a
  deprecation cycle.

## 2.3.0 — Unreleased — approval quorum contract parity

> **Correction (2026-05-05).** A caveat added earlier today claimed
> identity-attested approvals and quorum verification were not yet
> enforced on the deployed legacy evaluate entrypoint in
> `atlasent-api`. **That caveat was wrong.** The deployed entry is a
> thin shim that delegates to `handleEvaluate`, where the new gates
> were wired (atlasent-api PRs #291 / #294 / #296). The split was
> already collapsed by `4e502ae` on 2026-05-03 -- before the
> approval-artifact phase started -- so the new gates are enforced
> on the deployed entry today. See
> `atlasent-api/docs/adr/ADR-evaluate-path.md` (Status: **Resolved**)
> for the design record and the regression test that locks the shim
> form in place.

### Added

- `ApprovalQuorumV1`, `QuorumPolicy`, `QuorumRoleRequirement`,
  `QuorumIndependence`, `QuorumProof` -- Pydantic mirrors of the
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
  `IdentitySubject` -- Pydantic mirrors of the wire-stable
  `identity_assertion.v1` schema published in
  `contract/schemas/identity-assertion.schema.json` and the TS SDK.
  Re-exported from `atlasent.*`.
- `IdentityIssuerKey` + `IdentityTrustedIssuersConfig` -- Pydantic
  shape of the `IDENTITY_TRUSTED_ISSUERS` env var, the second trust
  root the verifier consults (independent of
  `APPROVAL_TRUSTED_ISSUERS`). Includes `allowed_roles` and
  `allowed_environments` issuer-scope fields.
- `ApprovalArtifactV1.identity_assertion` (optional) -- the artifact
  may now carry an independently-signed identity assertion. Required
  on the wire whenever `/v1-evaluate` calls the verifier with
  `requireIdentityAssertion: true` (i.e. when human approval is
  required); without it the server returns deny: `missing identity
  assertion`. The SDK keeps the field optional so shadow / preflight
  flows that don't verify can still construct artifacts.

### No new behavior

This release is contract parity only -- no client-side enforcement
was added. The verifier remains in the Deno edge functions; the
Python SDK only carries the assertion. Quorum / multi-approval is
explicitly out of scope.

## 2.1.0 — 2026-05-05 — approval artifact contract parity

### Added

- `ApprovalArtifactV1`, `ApprovalReviewer`, `ApprovalIssuer`,
  `ApprovalReference`, `PermitApprovalBinding`, `PrincipalKind` --
  Pydantic mirrors of the wire-stable types published in
  `contract/schemas/approval-artifact.schema.json` and the TS SDK
  (`approvalArtifact.ts`). Re-exported from `atlasent.*`.
- `ApprovalTrustedIssuersConfig` + `TrustedIssuerKey` -- Pydantic
  shape of the `APPROVAL_TRUSTED_ISSUERS` env var read server-side
  by `/v1-evaluate`. Server config only; the SDK exposes the model
  so operators can construct / lint / round-trip the JSON in CI.
  Includes the `allowed_action_types`, `allowed_environments`, and
  `required_role` issuer-scope fields.
- `EvaluateRequest.approval` (`ApprovalReference`) and
  `EvaluateRequest.require_approval` -- carried on
  `POST /v1-evaluate` so callers can submit a signed approval and
  hard-assert the gate even when the action_type-prefix heuristic
  doesn't match server-side.
- `EvaluateRequest.resource_id` and `EvaluateRequest.amount` --
  documented inputs to the canonical action hash that approval
  artifacts cover.
- `EvaluateResult.permit_approval` (`PermitApprovalBinding`) --
  surfaces the cryptographic linkage minted at issuance. Populates
  from BOTH wire shapes the server may emit: `permit.approval`
  nested per PermitV2 (atlasent-console) and top-level
  `permit_approval` (atlasent-api).
- `VerifyRequest.require_approval` -- caller assertion that the
  consume must produce a permit row with a populated approval
  binding; missing binding triggers `APPROVAL_LINKAGE_MISSING`.
- `VerifyResult.consumed` and `VerifyResult.approval` -- surface
  whether the atomic consume burned the permit (critically `True`
  on `APPROVAL_LINKAGE_MISSING` -- the permit is gone, do not retry)
  and the persisted approval binding.
- `AtlaSentClient.evaluate(...)` and `AsyncAtlaSentClient.evaluate(...)`
  gained `resource_id`, `amount`, `approval`, `require_approval`
  kwargs.
- `AtlaSentClient.verify(...)` and `AsyncAtlaSentClient.verify(...)`
  gained `require_approval` kwarg.
- 28 new tests in `tests/test_approval_artifact.py` mirror the
  TS-SDK vector suite -- all eight contract fixtures
  (`valid`, `expired`, `wrong-hash`, `agent-reviewer`,
  `missing-role`, `untrusted-issuer`, `wrong-signature`, `replay`)
  load via `ApprovalArtifactV1`; wire-shape parity checks for
  `EvaluateRequest`, `VerifyRequest`, `EvaluateResult`,
  `VerifyResult`; trusted-issuer config round-trip.

### No new behavior

This release is contract parity only -- no server-side semantics or
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
- `api_key` is no longer echoed in the request body -- the server
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
  "escalate"]` -- replaces the bool that used to live under the same
  name. (In the fail-closed `evaluate()` surface this is always
  `"allow"` when the result is returned; the other values appear
  when constructing or parsing the model directly.)
- `EvaluateResult.permit_token`, `request_id`, `expires_at`,
  `denial: { reason, code }`.
- `VerifyResult.valid: bool`, `outcome: Literal["allow", "deny"]`,
  `verify_error_code: str | None` -- surface the canonical handler.ts
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
compat with callers -- it is silently dropped. PR2 will add a
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

- **`AtlaSentDeniedError.outcome`** -- discriminator that distinguishes
  permit-side denial reasons (D4 of `LAST_20_EXECUTION_PLAN`).
  Populated from `/v1-verify-permit` `outcome` and typed as
  `PermitOutcome` (`permit_consumed | permit_expired | permit_revoked
  | permit_not_found`). Predicates `is_revoked`, `is_expired`,
  `is_consumed`, `is_not_found` map directly to the operator runbook
  matrix in `docs/REVOCATION_RUNBOOK.md` (atlasent meta).

  Pre-existing callers are unaffected -- `outcome` defaults to `None`
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

- **`list_audit_events()` and `create_audit_export()`.** Both
  `AtlaSentClient` and `AsyncAtlaSentClient` gain two new methods
  that close the long-standing `/v1-audit` parity gap. Together with
  the offline verifier (this release) and the pydantic models added
  here, customers can go from "I have an API key" to "I have a
  signed, offline-verifiable bundle of my org's audit events"
  without leaving the SDK:

        page = client.list_audit_events(
            types="evaluate.allow,policy.updated",
            limit=100,
        )
        # → AuditEventsResult(events=[AuditEvent(...)], total=..., next_cursor=..., rate_limit=...)

        result = client.create_audit_export(
            from_="2026-04-01T00:00:00Z",
            to="2026-04-30T23:59:59Z",
        )
        outcome = atlasent.verify_audit_bundle(result.bundle, keys=[...])

  `AuditEventsResult` is a pydantic model; `AuditExportResult` is a
  dataclass that wraps the raw server JSON so signature verification
  round-trips byte-for-byte (re-serializing through a pydantic model
  could reorder nested event fields and break the Ed25519 signature).
  Convenience accessors -- `result.export_id`, `result.events`,
  `result.signature`, etc. -- read from the preserved dict. A snake_case
  `from_` keyword sidesteps the Python reserved word without drifting
  from the wire.

  New public exports from `atlasent`:
  `AuditEvent`, `AuditEventsResult`, `AuditExportResult`,
  `AuditDecision`, `AuditExportSignatureStatus`.

- **Offline audit-bundle verifier.** `atlasent.verify_bundle(path,
  public_keys_pem=[...])` and the lower-level
  `atlasent.audit_bundle.verify_audit_bundle(bundle, keys)` produce a
  byte-faithful port of the reference verifier in
  `atlasent-api/supabase/functions/v1-audit/verify.ts`. End-to-end
  verification of a signed export from `POST /v1/audit/exports`:
  per-event SHA-256 hash chain, adjacency, `chain_head_hash` match,
  and detached Ed25519 signature. Rotation-aware via `signing_key_id`.
  Uses `cryptography` (now a hard dep). `canonical_json` and
  `signed_bytes_for` are exported for regulator-side tooling that
  wants to recompute envelope bytes out-of-band.
- Shared test fixtures at `contract/vectors/audit-bundles/` and
  reproducible generator at `contract/tools/gen_audit_bundles.py`.


## 1.4.0 — 2026-04-23

### Added

- **`key_self()` -- API-key self-introspection.** Both `AtlaSentClient`
  and `AsyncAtlaSentClient` gain a `key_self()` method that calls
  `GET /v1-api-key-self` and returns the server's description of the
  key this client was constructed with:

        info = client.key_self()
        # ApiKeySelfResult(key_id=..., organization_id=...,
        #                  environment='live', scopes=['evaluate', ...],
        #                  allowed_cidrs=['10.0.0.0/8'],
        #                  rate_limit_per_minute=1000,
        #                  client_ip='10.2.3.4',
        #                  expires_at='2026-12-31T23:59:59Z',
        #                  rate_limit=RateLimitState(...))

  Never includes the raw key or its hash -- introspection is
  intentionally read-only and safe to surface in operator dashboards.
  Useful for:

    - `IP_NOT_ALLOWED` debugging -- `client_ip` is the IP the server
      observed (first hop of X-Forwarded-For).
    - Proactive expiry warnings -- `expires_at` is the server-stored
      expiry (`None` means the key does not auto-expire).
    - Verifying scopes before attempting a scope-gated action.
    - "Which key am I?" in multi-tenant dashboards juggling more than
      one key.

  Response also includes `rate_limit` (the same `RateLimitState`
  surfaced on `evaluate`/`verify`), so key-introspection doubles as a
  cheap rate-limit probe without consuming a permit.

- `ApiKeySelfResult` exported from the package entry point (`from
  atlasent import ApiKeySelfResult`).

### Changed

- Internal refactor: the `_post` retry / error-mapping loop now
  delegates to a shared `_request(method, path, payload)` helper, and
  a parallel `_get` method exists for GET calls. Both `AtlaSentClient`
  and `AsyncAtlaSentClient` pick up the GET path so the rate-limit
  header parsing from 1.3.0 Just Works for key_self as well. No public
  API change.

### Non-breaking

Purely additive. Existing `evaluate` / `verify` / `gate` / `authorize`
/ `protect` APIs are unchanged -- same signatures, same return types,
same exception taxonomy.

## 1.3.0 — 2026-04-23

### Added

- **`rate_limit` field on every authed response.** The AtlaSent edge
  functions now emit `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
  and `X-RateLimit-Reset` headers on success responses (the 429 path
  with `Retry-After` was already handled). The client parses the
  header triple and surfaces it as a typed `RateLimitState` dataclass
  (`limit: int`, `remaining: int`, `reset_at: datetime`) on both
  `EvaluateResult.rate_limit` and `VerifyResult.rate_limit`. Clients
  can preemptively back off instead of waiting for a 429:

      from datetime import datetime, timezone
      import time

      result = client.evaluate("deploy", "ci-bot")
      if result.rate_limit and result.rate_limit.remaining < 10:
          delay = (
              result.rate_limit.reset_at - datetime.now(timezone.utc)
          ).total_seconds()
          if delay > 0:
              time.sleep(delay)

  `X-RateLimit-Reset` is accepted as either unix-seconds (the
  current server convention) or ISO 8601. `rate_limit` is `None`
  when any of the three headers is missing or unparseable -- covers
  older server deployments and internal endpoints that skip
  per-key limits.

- `RateLimitState` exported from the top-level `atlasent` namespace
  for consumers building their own back-off logic.

- Works identically on both `AtlaSentClient` and
  `AsyncAtlaSentClient`; the header parser is shared.

### Non-breaking

Adding `rate_limit: RateLimitState | None` to `EvaluateResult` and
`VerifyResult` is additive. Existing attribute access
(`result.decision`, `result.permit_token`, etc.) is unchanged. No
wire-format change -- the headers have been emitted by the server
but previously ignored by the SDK.

## 1.2.0 — 2026-04-23

### Added

- **`AtlaSentError.request_id`.** Every SDK-raised exception now
  carries the `X-Request-ID` the client sent with the failing
  request. Paste it into support tickets to correlate with
  server-side log entries. The attribute is populated on every
  raise site -- transport errors, HTTP-status errors,
  `RateLimitError`, `AtlaSentDenied`, and the post-response
  malformed-body `bad_response` check -- so call sites can rely on
  it without defensive `getattr`:

      try:
          result = authorize(...)
      except AtlaSentError as err:
          log.error("atlasent call failed rid=%s code=%s",
                    err.request_id, err.code)

  The TypeScript SDK already exposed `requestId` on `AtlaSentError`;
  this closes the Python parity gap.

- **`Retry-After` now accepts the HTTP-date form** in addition to
  numeric delta-seconds, per RFC 9110 §10.2.3. Previously,
  `RateLimitError.retry_after` silently became `None` when the
  server sent a date like `"Wed, 21 Oct 2026 07:28:00 GMT"`,
  causing retry-pacing code to skip the back-off. Now both forms
  are parsed; dates in the past are clamped to `0.0`.

### Changed

- `AtlaSentClient._post` / `AsyncAtlaSentClient._post` now return
  `(body, request_id)` instead of `body`. This is an internal
  signature; no public API change. It lets the `evaluate` /
  `verify` shape-check raise sites thread `request_id` into the
  exception they raise after `_post` returns, so those exceptions
  now carry the same correlation id as the transport-level ones.

### Notes

- Additive only -- no field renames, no removed exports, no wire
  format change. Drop-in for 1.1.0 callers.

## 1.1.0 — 2026-04-23

### Added

- **`atlasent.protect(...)` -- the one-call authorization primitive.**
  Fail-closed by construction: on allow, returns a verified `Permit`;
  on deny (or verification failure, transport error, auth error,
  rate limit), raises. There is no `permitted=False` return path to
  forget.

      from atlasent import protect

      permit = protect(
          agent="deploy-bot",
          action="deployment.production",
          context={"commit": commit, "approver": approver},
      )
      # …execute the action. If we got here, AtlaSent authorized it.

  Internally does `evaluate` → `verify_permit` in a single call and
  returns a `Permit` carrying `permit_id`, `permit_hash`, `audit_hash`,
  `reason`, and `timestamp`. Matches the TypeScript SDK's
  `atlasent.protect()` for cross-language parity.

  Available as:
  - Module-level: `atlasent.protect(...)` using the globally
    configured client (same env-var / `configure()` story as
    `authorize()`).
  - Method: `AtlaSentClient.protect(...)` and
    `AsyncAtlaSentClient.protect(...)`.

- **`Permit` dataclass** -- the return type of `protect()`. Frozen
  dataclass with `permit_id`, `permit_hash`, `audit_hash`, `reason`,
  `timestamp`. Mirrors the TypeScript SDK's `Permit` interface.

- **`AtlaSentDeniedError`** -- new exception raised exclusively by
  `protect()` on policy denial or permit-verification failure.
  Subclass of the existing `AtlaSentDenied`, so
  `except AtlaSentDenied:` still catches `protect()` denials;
  use `except AtlaSentDeniedError:` to distinguish a `protect()`
  denial from the older `authorize()` / `evaluate()` denial surface.

  Attributes:
  - `decision: "deny" | "hold" | "escalate"` -- forward-compatible
    union; only `"deny"` is emitted against today's API
  - `evaluation_id: str` -- opaque decision id (also available as
    the inherited `permit_token` for backward compat)
  - `reason: str` -- policy engine's explanation
  - `audit_hash: str` -- hash-chained audit-trail entry
  - `request_id: str | None` -- correlation id, when available

- **`AtlaSentDecision` type alias** -- `Literal["deny", "hold",
  "escalate"]`, exported for type-checked `match` statements.

- **`examples/protect.py`** -- canonical quickstart showing error
  handling for both `AtlaSentDeniedError` and `AtlaSentError`.

### Notes

- Additive. No existing export renamed or removed. `authorize()`,
  `evaluate()`, `verify()`, `gate()`, `AtlaSentClient`, and all
  existing error types keep working unchanged. `protect()` is the
  new recommended entry point; `authorize()` remains supported for
  callers who prefer the data-not-exception branching idiom.
- 17 new tests in `tests/test_protect.py` covering sync + async
  clients, module-level shortcut, allow path, policy-deny,
  verify-revoked, transport-error propagation, payload shape, and
  the `AtlaSentDeniedError` class itself. 167 / 167 tests pass.

## 1.0.0 — 2026-04-17

First stable release. Public exports in `atlasent/__init__.py` are
the supported v1 surface; pin to `>=1.0.0,<2.0.0`.

### Added

- Cross-language `RELEASE_NOTES.md` covering the v1.0.0 surface for
  both `atlasent` and `@atlasent/sdk`.
