# Changelog

All notable changes to `@atlasent/sdk` are documented here. The SDK
follows [semver](https://semver.org/): breaking changes bump the major
(or minor while on 0.x).

---

## @atlasent/sdk 2.7.0 (2026-05-24)

### New features

#### `client.replay()` — ADR-015 Phase C parity runtime

Third runtime in the policy-parity contract
(`POLICY_PARITY_CONTRACT.md §Replay, parity v2`). Re-evaluates a
prior decision against the current policy bundle to surface drift.

```ts
import { AtlaSentClient } from "@atlasent/sdk";

const client = new AtlaSentClient({ apiKey: "ask_live_..." });
const result = await client.replay({ evaluationId: "<uuid>" });

if (result.varianceKind !== "NONE") {
  console.warn("Policy drift detected:", result.varianceKind);
}
```

**Wire mapping** (server `variance` → SDK `varianceKind`):

| Wire value        | SDK `varianceKind` | Meaning                              |
|-------------------|--------------------|--------------------------------------|
| `NONE`            | `"NONE"`           | Exact match — no drift               |
| `DECISION_CHANGED`| `"POLICY_DRIFT"`   | Policy changed; outcome differs      |
| `ENVELOPE_DRIFT`  | `"ENVELOPE_DRIFT"` | Envelope hash mismatch               |
| `ENGINE_DRIFT`    | `"ENGINE_DRIFT"`   | Engine retired/unknown               |
| `CHAIN_TAMPER`    | `"CHAIN_TAMPER"`   | Audit chain tampered                 |
| `BUNDLE_MISSING`  | `"BUNDLE_MISSING"` | No policy bundle recorded            |
| 409 + "engine"    | `"ENGINE_DRIFT"`   | Engine retired (409 path)            |
| 409 + "bundle"    | `"BUNDLE_MISSING"` | Bundle missing (409 path)            |

**Never throws** on `409 replay_not_eligible` — returns
`acceptsReplay: false` with the appropriate variance kind.

#### New type exports

- `ReplayVarianceKind` — union of all six variance strings
- `ReplayRequest` — `{ evaluationId: string }`
- `ReplayResponse` — full response envelope

All three are re-exported from the package root (`"@atlasent/sdk"`).

### Tests

9 new vitest cases in `typescript/test/client-replay.test.ts`:
- NONE variance (allow→allow)
- DECISION_CHANGED → POLICY_DRIFT
- ENVELOPE_DRIFT (no `replayedDecision`)
- 409 + engine message → ENGINE_DRIFT (no throw)
- 409 + bundle message → BUNDLE_MISSING (no throw)
- URL path construction (`/v1/decisions/:id/replay`)
- POST method assertion
- Rate-limit header parsing
- `decision_id` fallback to `evaluationId`

### Conformance vectors

5 vectors added to `contract/vectors/replay.json`:
`replay-none-allow`, `replay-policy-drift`, `replay-envelope-drift`,
`replay-engine-drift`, `replay-bundle-missing`.

---

## @atlasent/sdk 2.6.0 (2026-05-17)

### New features

#### Cross-org impersonation (`client.createImpersonationGrant()` / `client.exchangeImpersonationToken()` / `client.validateImpersonationToken()`)

Three new methods backed by `POST /v1/cross-org/impersonation/grants`,
`POST /v1/cross-org/impersonation/grants/:id/exchange`, and
`POST /v1/cross-org/impersonation/validate`.

Allows a source org's service account to act on behalf of a target org
for a scoped, time-bounded operation. The grant is recorded in the
audit chain; the exchanged token carries the impersonation context and
expires independently of the grant.

```ts
const { grant } = await client.createImpersonationGrant({
  target_org_id: "org_target",
  scopes: ["evaluate:write"],
  ttl_seconds: 3600,
});
const { token } = await client.exchangeImpersonationToken(grant.id);
const { result } = await client.validateImpersonationToken(token.token);
```

#### Incentive signal feedback (`client.recordSignalAction()` / `client.recordSignalOutcome()`)

Two new methods backed by `POST /v1/signals/actions` and
`POST /v1/signals/actions/:id/outcome`.

Provides a feedback loop for policy tuning: record a governance signal
action (e.g. `"approve"`, `"deny"`, `"escalate"`) and then close the
loop by recording its real-world outcome. Both entries appear in the
audit log under `signal.action.*` event types.

```ts
const { action } = await client.recordSignalAction({
  action_type: "approve",
  actor_id: "reviewer-42",
  context: { ticket: "INC-99" },
});
await client.recordSignalOutcome(action.id, { outcome: "resolved" });
```

---

## @atlasent/sdk 2.5.0 (2026-05-10)

### New features

#### Governance agents (`client.listGovernanceAgents()` / `client.listGovernanceEvaluations()` / `client.listGovernanceFindings()`)

Three new read-only methods backed by `GET /v1/governance/agents`,
`GET /v1/governance/evaluations`, and `GET /v1/governance/findings`.

Surfaces the governance agent registry and its evaluation / finding
history so operator dashboards can display compliance posture without
requiring a separate control-plane query.

```ts
const { agents } = await client.listGovernanceAgents();
const { evaluations } = await client.listGovernanceEvaluations({ agentId: agents[0].id });
const { findings } = await client.listGovernanceFindings({ severity: "high" });
```

#### Regulatory escalations (`client.createRegulatoryEscalation()` / `client.getRegulatoryEscalationStatus()`)

Two new methods backed by `POST /v1/regulatory-escalations` and
`GET /v1/regulatory-escalations/:id/status`.

Routes a decision to an authority at a specified regulatory level
(`"L1"` through `"L4"`). The status endpoint returns the current
escalation disposition and any authority response.

```ts
const { escalation } = await client.createRegulatoryEscalation({
  decision_id: "dec_abc",
  authority_level: "L2",
  regulation_code: "EU-AI-ACT-12",
});
const { status } = await client.getRegulatoryEscalationStatus(escalation.id);
```

---

## @atlasent/sdk 2.4.0 (2026-05-03)

### New features

#### Budget exceptions (`client.createBudgetException()` / `client.getBudgetExceptionStatus()` / `client.approveBudgetException()`)

Three new methods backed by `POST /v1/budget-exceptions`,
`GET /v1/budget-exceptions/:id/status`, and
`POST /v1/budget-exceptions/:id/approve`.

Provides a structured path for agents to request spend above a
policy-set threshold and for human approvers to grant or deny that
request. The full lifecycle (create → review → approve/deny) is
recorded in the audit log.

```ts
const { exception } = await client.createBudgetException({
  requested_amount_usd: 5000,
  justification: "Emergency infrastructure scaling",
});
const { status } = await client.getBudgetExceptionStatus(exception.id);
await client.approveBudgetException(exception.id, { approved_amount_usd: 4000 });
```

#### Anomaly response (`client.createAnomalyResponseRule()` / `client.listAnomalyResponseRules()` / `client.triggerAnomalyResponse()`)

Three new methods backed by `POST /v1/anomaly-response/rules`,
`GET /v1/anomaly-response/rules`, and
`POST /v1/anomaly-response/trigger`.

Configures automated responses to detected anomalies (e.g. rate spikes,
unexpected deny patterns). Rules are evaluated server-side when an
anomaly event is triggered; the response action (e.g. `"revoke"`,
`"alert"`, `"quarantine"`) is recorded in the audit log.

---

## @atlasent/sdk 2.3.0 (2026-04-26)

### New features

#### Cross-org permission negotiation (`client.checkCrossOrgPermission()` / `client.listCrossOrgPermissionChecks()`)

Two new methods backed by `POST /v1/cross-org/permissions/check` and
`GET /v1/cross-org/permissions`.

Allows an agent in one organization to check whether it is permitted to
perform an action on behalf of, or interacting with, a resource in a
different organization. Useful for federated multi-tenant architectures
where trust boundaries span org boundaries.

```ts
const result = await client.checkCrossOrgPermission({
  source_org_id: "org_a",
  target_org_id: "org_b",
  permission_type: "data.read",
  actor_id: "agent-99",
});
```

#### Organizational risk graph (`client.computeOrgRisk()` / `client.getLatestOrgRisk()` / `client.listOrgRiskHistory()`)

Three new methods backed by `POST /v1/governance/risk/compute`,
`GET /v1/governance/risk/latest`, and `GET /v1/governance/risk/history`.

Triggers a fresh risk computation for the calling org, retrieves the
most recent score, and pages through historical scores for trend
analysis. Risk scores are composite metrics derived from audit-chain
evidence, permit lifecycle data, and governance agent findings.

```ts
await client.computeOrgRisk({ include_historical: true });
const { score } = await client.getLatestOrgRisk();
const { scores } = await client.listOrgRiskHistory({ limit: 30 });
```

---

## @atlasent/sdk 2.2.0 (2026-04-05)

### New features

#### Connector management

Seven new methods across the connector management surface:

| Method | Endpoint |
|--------|----------|
| `listConnectors()` | `GET /v1/governance/connectors` |
| `installConnector()` | `POST /v1/governance/connectors` |
| `authenticateConnector()` | `POST /v1/governance/connectors/:id/authenticate` |
| `syncConnector()` | `POST /v1/governance/connectors/:id/sync` |
| `revokeConnector()` | `POST /v1/governance/connectors/:id/revoke` |
| `rotateConnectorCredentials()` | `POST /v1/governance/connectors/:id/rotate-credentials` |
| `listEnforcementPolicies()` | `GET /v1/governance/enforcement-policies` |
| `upsertEnforcementPolicy()` | `POST /v1/governance/enforcement-policies` |

Connectors represent external systems (GitHub, Jira, Slack, …) that
can enforce AtlaSent policy decisions. Installing a connector registers
the integration; authenticating stores encrypted credentials;
syncing pulls the latest state; revoking removes access.

---

## @atlasent/sdk 2.1.0 (2026-03-22)

### New features

#### Governance graph queries (`client.queryGovernanceGraph()`)

New method backed by `GET /v1/governance/graph/query?type=<queryType>`.

Dispatchs to one of three named traversals:
- `"all_approvers"` — all principals with approve authority
- `"pending_escalations"` — open HITL escalations awaiting review
- `"user_approvals"` — approvals recorded for a specific actor
  (requires `params.actor_id`)

```ts
const { results } = await client.queryGovernanceGraph("user_approvals", {
  actor_id: "reviewer-42",
});
```

The return type narrows automatically based on the literal `queryType`
argument, so TypeScript infers the correct `results` row type.

#### Incident timeline reconstruction (`client.getIncidentTimeline()`)

New method backed by
`GET /v1/governance/timeline/incident/:incidentId`.

Returns a multi-system execution timeline for an incident, including
all §13.1 audit columns (`delegation_chain_id`,
`replay_of_execution_id`, `policy_version_id`, `bundle_version_id`).

Backed server-side by `reconstruct_incident_chains_v2()`, which fixes
the `executor_id → actor_id` bug that silently produced empty timelines
in the original function.

---

## @atlasent/sdk 2.0.0 (2026-03-01)

### Breaking changes

#### `Decision` type now lowercase-canonical

The `Decision` type previously emitted `"ALLOW"` / `"DENY"`. It now
reflects the canonical wire values (`"allow" | "deny" | "hold" |
"escalate"`) so the `decision` and `decision_canonical` fields on
`EvaluateResponse` carry identical values and types.

Callers that previously checked `=== "ALLOW"` must update to
`=== "allow"`. The `decision_canonical` field (always lowercase) is
also available and was unaffected; prefer it on new code.

#### `EvaluateRequest` renamed fields

`action` / `agent` are the canonical field names (unchanged).
The legacy `action_type` / `actor_id` wire fields are still accepted
by the server; the client normalises both directions.

### New features

#### HITL escalation management (full API surface)

Seven new methods:

| Method | Endpoint |
|--------|----------|
| `createHitlEscalation()` | `POST /v1/hitl` |
| `listHitlEscalations()` | `GET /v1/hitl` |
| `getHitlEscalation()` | `GET /v1/hitl/:id` |
| `listHitlApprovals()` | `GET /v1/hitl/:id/approvals` |
| `getHitlChain()` | `GET /v1/hitl/:id/chain` |
| `approveHitlEscalation()` | `POST /v1/hitl/:id/approve` |
| `rejectHitlEscalation()` | `POST /v1/hitl/:id/reject` |
| `escalateHitlEscalation()` | `POST /v1/hitl/:id/escalate` |
| `timeoutHitlEscalation()` | `POST /v1/hitl/:id/timeout` |

#### `client.subscribeDecisions()` — live decision stream

New `AsyncGenerator` method backed by `GET /v1-decisions-stream` (SSE).
Yields `DecisionStreamEvent` objects as the server emits them;
reconnects transparently when `lastEventId` is supplied.

#### Legacy `EvaluateRequest` bridge

`evaluate()` now accepts either the v2 shape (`action_type` /
`actor_id`) or the v1.x shape (`action` / `agent`) via
`normalizeEvaluateRequest`. Legacy callers receive a `console.warn`
deprecation notice.

---

## @atlasent/sdk 1.9.0 (2026-02-15)

### New features

#### Batch evaluate (`client.evaluateBatch()`)

New method backed by `POST /v1-evaluate-batch`. Sends up to 100
decision requests in a single round-trip; one rate-limit token is
consumed for the whole batch. Pass an optional `batchId` for
idempotency (cached response returned within 24 h when the same ID
and identical items are retried).

```ts
const { items } = await client.evaluateBatch([
  { agent: "bot-1", action: "file.read" },
  { agent: "bot-2", action: "file.write", context: { path: "/tmp" } },
]);
```

#### Evaluate preflight (`client.evaluatePreflight()`)

New method that wraps `POST /v1-evaluate?include=constraint_trace`.
Returns the regular `EvaluateResponse` plus a `constraintTrace`
showing which policy stages passed, failed, or were skipped. Use at
workflow submission time to surface trivial defects before pushing onto
an approval queue.

---

## @atlasent/sdk 1.8.0 (2026-02-01)

### New features

#### Deploy Gate (`client.deployGate()`)

New high-level helper that runs the full `production.deploy` guard:
evaluate the action, verify the issued permit, and return `allowed`
with audit evidence. Never treats an offline permit artifact as
sufficient authorization.

```ts
const gate = await client.deployGate({ agent: "ci-bot", context: { sha: "abc" } });
if (!gate.allowed) throw new Error(gate.reason);
```

#### Streaming evaluation (`client.protectStream()`)

New `AsyncIterable` method backed by `POST /v1-evaluate-stream` (SSE).
Yields `StreamProgressEvent` and `StreamDecisionEvent` objects.
Hardened with per-event timeout, exponential-backoff reconnect, and
`StreamParseError` / `StreamTimeoutError` typed errors.

---

## @atlasent/sdk 1.7.0 (2026-01-18)

### New features

#### Audit export (`client.createAuditExport()`)

New method backed by `POST /v1-audit/exports`. Returns a signed bundle
(`signature`, `chain_head_hash`, `events`) wire-identical to the
server so it can be handed to `verifyBundle()` / `verifyAuditBundle()`
without reshaping.

#### Audit events listing (`client.listAuditEvents()`)

New method backed by `GET /v1-audit/events`. Cursor-paged; all filter
params (`types`, `actorId`, `from`, `to`, `limit`, `cursor`) map
directly to server query params.

---

## @atlasent/sdk 1.6.0 (2026-01-04)

### New features

#### Key self-describe (`client.keySelf()`)

New method backed by `GET /v1-api-key-self`. Returns `keyId`,
`organizationId`, `environment`, `scopes`, `allowedCidrs`,
`rateLimitPerMinute`, `clientIp`, and `expiresAt`.

Useful for `IP_NOT_ALLOWED` debugging (server reports the exact IP it
observed) and for proactive expiry warnings in health-check endpoints.

---

## @atlasent/sdk 1.5.0 (2025-12-21)

### New features

#### Permit listing (`client.listPermits()`)

New method backed by `GET /v1/permits`. Cursor-paged; filters on
`status`, `actorId`, `actionType`, `from`, `to`, `limit`, `cursor`.

#### Permit validity polling (`client.checkPermitValid()`)

New lightweight method backed by `GET /v1/permits/:id/valid`. Returns
only the status snapshot — optimized for high-frequency guard
heartbeat polling.

---

## @atlasent/sdk 1.4.0 (2025-12-07)

### New features

#### `revokePermitById()` / `verifyPermitById()` — canonical REST surface

Two new methods backed by the canonical permit endpoints
(`POST /v1/permits/:id/revoke` and `POST /v1/permits/:id/verify`).
Return the full `PermitRecord` and the unified verification envelope
respectively. The legacy `revokePermit()` / `verifyPermit()` methods
are deprecated and will be removed in `@atlasent/sdk@3`.

#### `getPermit()` — permit lifecycle introspection

New method backed by `GET /v1/permits/:id`. Returns the full lifecycle
state (`status`, all timestamps, `revoked_at` / `revoked_by` /
`revoke_reason`).

---

## @atlasent/sdk 1.3.0 (2025-11-23)

### New features

#### Retry policy

New `retryPolicy` option on `AtlaSentClientOptions`. Merged with
defaults (`maxAttempts: 3`, `initialDelayMs: 200`, `maxDelayMs: 5000`,
`factor: 2`). Retries network errors and 5xx / 429 responses with
exponential back-off.

#### Context size warning

When the `context` object passed to `evaluate()` or `verifyPermit()`
exceeds the `maxProperties: 64` soft cap, the SDK emits a
`console.warn` rather than silently letting the server reject the
request at runtime.

---

## @atlasent/sdk 1.2.0 (2025-11-09)

### New features

#### `AtlaSentError` structured errors

All SDK errors now extend `AtlaSentError` with `code`,
`status`, `requestId`, and `body` fields. Error codes: `invalid_api_key`,
`forbidden`, `not_found`, `conflict`, `rate_limited`, `server_error`,
`bad_request`, `bad_response`, `network`, `timeout`.

#### `StreamParseError` / `StreamTimeoutError`

Two new typed error subclasses thrown exclusively by streaming methods.
`StreamParseError` carries the raw unparseable chunk; `StreamTimeoutError`
includes the configured `timeoutMs`.

---

## @atlasent/sdk 1.1.0 (2025-10-26)

### New features

#### TLS enforcement

The constructor now rejects non-`https://` base URLs unless the
`ATLASENT_ALLOW_INSECURE_HTTP=1` environment variable (Node) or
`globalThis.ATLASENT_ALLOW_INSECURE_HTTP === "1"` (browser dev) escape
hatch is set. Non-HTTP schemes (`data:`, `file:`, …) are rejected
unconditionally.

#### API key format validation

The constructor validates that `apiKey` matches
`` ask_(live|test)_<entropy> `` on construction rather than surfacing
a confusing 401 mid-request.

---

## @atlasent/sdk 1.0.0 (2025-10-12)

Initial public release.

### Features

- `AtlaSentClient` with `evaluate()` and `verifyPermit()` methods
- Native `fetch`-backed HTTP with `AbortSignal.timeout`
- `revokePermit()` method
- `RateLimitState` parsed from `X-RateLimit-*` headers
- `User-Agent` header with SDK version and runtime
- `AtlaSentClientOptions` with `apiKey`, `baseUrl`, `timeoutMs`, `fetch`
