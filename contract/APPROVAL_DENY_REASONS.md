# Approval-artifact deny reasons

Stable strings returned by `verifyApprovalArtifact()` (atlasent-console + atlasent-api `_shared/approval_artifact.ts`). The strings are part of the contract — auditors and SDKs match on them, so changing the wording is a wire-format change. Add new reasons by appending; never rename or repurpose an existing one.

## Order of checks

The verifier runs the checks in this order and returns the **first** failing reason. Tests in `atlasent-sdk/typescript/test/approval-artifact-vectors.test.ts` lock this order; drift fails the suite.

### Approval-artifact checks

| # | Check                                       | Reason on failure                                |
|---|---------------------------------------------|--------------------------------------------------|
| 1 | artifact present + object-shaped            | `missing approval artifact`                      |
| 2 | `version === "approval_artifact.v1"`        | `invalid approval artifact version`              |
| 3 | `tenant_id` matches expected tenant         | `approval tenant mismatch`                       |
| 4 | `action_hash` matches canonical hash        | `approval does not match this action`            |
| 5 | `reviewer.principal_kind === "human"`       | `reviewer must be human`                         |
| 6 | issuer (`issuer_id`, `kid`) is in trust cfg | `untrusted approval issuer`                      |
| 7 | reviewer carries `required_role` (issuer's wins over caller's) | `reviewer lacks required role`         |
| 8 | issuer's `allowed_action_types` matches     | `issuer not authorized for this action type`     |
| 9 | issuer's `allowed_environments` matches     | `issuer not authorized for this environment`     |
| 10| `expires_at > now`                          | `approval expired`                               |
| 11| `issued_at <= now + 5min`                   | `approval issued in the future`                  |
| 12| HS256 / Ed25519 signature valid             | `invalid approval signature`                     |

### Identity-assertion checks (between #12 and #13)

When `/v1-evaluate` calls the verifier with `requireIdentityAssertion: true` (i.e. the action requires human approval), the artifact MUST carry an `identity_assertion` signed by a trusted **identity** issuer (separate trust root from the approval issuer). The IdP independently vouches that the reviewer is a real human with the required role; the approval-issuer's self-claim alone is not sufficient.

| #   | Check                                                | Reason on failure                                          |
|-----|------------------------------------------------------|------------------------------------------------------------|
| 12.1 | assertion present (when required)                   | `missing identity assertion`                               |
| 12.2 | `version === "identity_assertion.v1"`               | `invalid identity assertion version`                       |
| 12.3 | `binding.tenant_id` matches expected                | `identity assertion tenant mismatch`                       |
| 12.4 | `binding.action_hash` matches expected              | `identity assertion does not match this action`            |
| 12.5 | `subject.principal_kind === "human"`                | `identity assertion subject must be human`                 |
| 12.6 | `subject.principal_id === reviewer.principal_id`    | `identity assertion subject does not match reviewer`       |
| 12.7 | `binding.approval_id === artifact.approval_id`      | `identity assertion does not match this approval`          |
| 12.8 | `role` matches effective required role              | `identity assertion role does not match required role`     |
| 12.9 | `binding.environment` matches expected environment  | `identity assertion environment mismatch`                  |
| 12.10| identity issuer (`issuer_id`, `kid`) in trust cfg   | `untrusted identity issuer`                                |
| 12.11| identity issuer's `allowed_roles` satisfied         | `identity issuer not authorized for this role`             |
| 12.12| identity issuer's `allowed_environments` satisfied  | `identity issuer not authorized for this environment`      |
| 12.13| `expires_at > now`                                  | `identity assertion expired`                               |
| 12.14| `issued_at <= now + 5min`                           | `identity assertion issued in the future`                  |
| 12.15| HS256 / Ed25519 signature valid                     | `invalid identity assertion signature`                     |

### Replay protection (last)

| #  | Check                                       | Reason on failure                                |
|----|---------------------------------------------|--------------------------------------------------|
| 13 | `nonce` not previously consumed             | `approval replay detected`                       |

A pass through all 13 returns:

```json
{
  "ok": true,
  "approval_id": "<from artifact>",
  "reviewer_id": "<reviewer.principal_id>",
  "artifact_hash": "<sha256 over canonical signing payload>"
}
```

## Wire-side propagation

When the gate denies, the `/v1-evaluate` response is shaped as:

```json
{
  "decision": "deny",
  "deny_code": "APPROVAL_ARTIFACT_INVALID",
  "deny_reason": "<one of the strings above>",
  "permit_token": null
}
```

The `deny_code` is a coarse-grained machine-actionable identifier; the `deny_reason` is the precise verifier message. The reason can be parsed by SDKs to drive client-side branching (e.g., "tenant mismatch" routes to a config error; "expired" prompts a re-approval flow).

## Permit-side propagation

`/v1-verify-permit` does not re-run the artifact verifier — the artifact was already verified at issuance and the binding is persisted on the permit row. If the request asserts `require_approval=true` (or the action_type prefix triggers `requiresHumanApproval` server-side) and the permit row has no `approval` block, the response is:

```json
{
  "valid": false,
  "outcome": "deny",
  "verify_error_code": "APPROVAL_LINKAGE_MISSING",
  "consumed": true,
  "approval": null,
  "reason": "permit lacks approval binding for an approval-required action"
}
```

`consumed: true` is critical — the atomic verify-and-consume already burned the permit. Do not retry; the action must remain blocked until a fresh evaluate-and-permit cycle (with a verified artifact) issues a new permit.

## Test vectors

`atlasent-sdk/contract/vectors/approval-artifact/` ships a fixture for each negative reason plus `valid` and `replay`. Each fixture is self-describing — verifier inputs and expected outcome ride alongside the artifact, so the same JSON files can be loaded directly by Deno tests in atlasent-console and atlasent-api.
