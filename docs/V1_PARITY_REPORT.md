# V1 Parity Report — TypeScript ↔ Python SDK

**Status:** snapshot · **Date:** 2026-05-28 · **Scope:** V1 convergence P0 audit

This is a point-in-time parity inventory of the TypeScript and Python SDKs
for the V1 pilot. It complements the registration-driven matrix in
[`docs/api-parity.md`](./api-parity.md), which is enforced in CI; this report
is a human-readable summary intended for the V1 release governance review.

For the canonical per-method handler matrix and CI enforcement, see
`docs/api-parity.md`. This report focuses on **pilot-critical** symbols.

## Source-of-truth versions

| Surface     | Version in source | Latest on registry |
| ----------- | ----------------- | ------------------ |
| TypeScript  | `2.11.0`          | `2.10.0` (npm)     |
| Python      | `2.12.0`          | `2.10.0` (PyPI)    |

Both registries lag the in-repo source. The `atlasent-action` and `atlasent-examples`
pins target the latest **published** versions (`2.10.0`); publication of
`2.11.0`/`2.12.0` is an operator action and out of scope for this PR.

## Pilot-critical surface — symmetry check

The four primitives required for V1 pilot are: `evaluate`, `protect`,
`verifyPermit` / `verify_permit`, and offline audit-bundle verification.

| Primitive                                  | TypeScript                                       | Python                                              | Symmetric |
| ------------------------------------------ | ------------------------------------------------ | --------------------------------------------------- | --------- |
| Raw decision                               | `evaluate()` (`protect.ts`)                      | `evaluate()` (`authorize.py`)                       | Yes       |
| Fail-closed wrapper                        | `protect()` (`protect.ts`)                       | `protect()` (`authorize.py`)                        | Yes       |
| Post-permit verification                   | `verifyPermit` (via `requirePermit.ts`)          | `verify_permit` (via `require_permit.py`)           | Yes       |
| Offline evidence-bundle verifier           | `verifyEvidenceBundle()` (`replay.ts`)           | `verify_evidence_bundle()` (`replay.py`)            | Yes       |
| Compliance evidence bundle sub-client      | `client.evidenceBundles.*` (`evidence-bundle.ts`)| `evidence_bundle.py` + `EvidenceBundlesClient`      | Yes       |
| SCIM 2.0 provisioning                      | `client.scim.*` (`scim.ts`)                      | `scim.py` + `scim_client.py`                        | Yes       |
| Multi-IdP token refresh                    | `client.auth.*` (`auth.ts`)                      | `auth.py` (`refresh_token`, `refresh_with_idp`, …)  | Yes       |
| Decision type alias                        | `Decision` exported from root                    | `Decision` literal type in `models.py`              | Yes       |
| Audit bundle                               | `auditBundle.ts`                                 | `audit_bundle.py`                                   | Yes       |
| Webhook guard / connector                  | `webhook.ts`                                     | `webhook.py`                                        | Yes       |
| HITL surface                               | `hitl.ts`                                        | `hitl.py`                                           | Yes       |

**Verdict:** all pilot-critical primitives are symmetric. No V1 blockers.

## TypeScript-only modules (non-pilot)

These surfaces exist in `typescript/src/` but have no Python equivalent. None
are required for V1 pilot; all are advanced governance surfaces deferred to V2
or framework-specific helpers irrelevant to Python deployments.

- **Framework adapters:** `express`, `hono` (TS-only web frameworks).
- **V2 governance graph:** `anomalyResponse`, `crossOrgImpersonation`,
  `crossOrgPermission`, `delegationPropagation`, `disputeReversal`,
  `governanceGraph`, `identityAssertion`, `incentiveAlignment`,
  `incentiveSignalFeedback`, `incidentReconstruction`, `liabilityAttribution`,
  `orgRiskGraph`, `regulatoryEscalation`, `sandboxDiff`, `shadow`.
- **V2 finance:** `autonomousFinancial`, `budgetExceptions`, `budgetaryGovernance`,
  `economicEvidence`, `economicRisk`, `financialAction`, `financialDashboard`,
  `financialGovernance`, `financialQuorum`.
- **V2 approval:** `approvalQuorum`, `approvalRuntime`.
- **V2 evidence:** `evidenceEngine`, `controlSurface`, `connectorManagement`.
- **Other:** `actionContext`, `compat`, `governanceEnforcement`, `overrides`,
  `proof`, `retry`, `state`, `v1Types`, `v2`, `verticals/*`.

## Python-only modules (non-pilot)

These surfaces exist in `python/atlasent/` but have no TypeScript equivalent.
All are Python-idiomatic helpers (async runtime, caching, config helpers) or
billing surfaces that ship through a separate TS package.

- **Async / runtime:** `aio`, `async_client`, `cache`, `config`, `logging`.
- **Billing:** `billing` (TS ships `@atlasent/billing` as a separate package).
- **Guard / runtime helper:** `guard`, `evidence_exports`.
- **Models module:** `models` (TS inlines model types in `types.ts` / `v1Types.ts`).

## Risks remaining

- **Registry lag:** SDK source ahead of published artifacts. Downstream pins
  cannot reach the new sub-clients (`client.auth`, `client.scim`,
  `client.evidenceBundles`) until publish. Tracked as an operator action.
- **Python version 2.12.0 vs TS 2.11.0:** the Python source has advanced one
  minor ahead of TS. Inspect `python/atlasent/CHANGELOG.md` (if present) for
  the 2.12.0 delta before publication to confirm it does not introduce
  Python-only API surface that violates the parity invariant.
- **Framework adapters asymmetric by design:** `express`/`hono` are TS-only.
  Python uses ASGI/WSGI through `guard.py` instead. Documented above; not a bug.

## Method-level enforcement

CI parity enforcement is registration-driven via `// @hitl-method` (TS) and
`# @hitl-method` (Py) annotations, with the matrix in `docs/api-parity.md`.
That mechanism remains the source of truth for per-method gating. This report
is a complementary snapshot for the V1 release review.
