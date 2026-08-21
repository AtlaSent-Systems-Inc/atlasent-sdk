# atlasent-enforce

**Alpha.** Non-bypassable execution wrapper around the AtlaSent v1 SDK.
`Enforce.run()` is the only public way to execute a gated action — it
always drives `evaluate -> verify_permit -> execute` in that order,
fails closed on any error condition, and never gives the caller a way
to skip straight to `execute`.

Spec: `contract/ENFORCE_PACK.md` in
[atlasent-sdk](https://github.com/AtlaSent-Systems-Inc/atlasent-sdk).
SIM-01..SIM-12 (`contract/scenarios/`) gate every release.

## Install

```bash
pip install atlasent-enforce
```

Python 3.10+ required. `atlasent-enforce` has no runtime dependencies
of its own — bring any client that implements the two async methods
below (typically the `atlasent` package's `AtlaSentClient`).

## Quickstart

```python
from atlasent_enforce import Bindings, Enforce, RunRequest

# Any object with async evaluate(dict) -> EvaluateResponse and
# async verify_permit(str) -> VerifiedPermit satisfies EnforceCompatibleClient.
enforce = Enforce(
    client=client,
    bindings=Bindings(org_id="org_123", actor_id="svc:deploy-bot", action_type="deploy"),
    fail_closed=True,  # non-toggleable — construction raises if this is False
)

async def deploy(permit):
    # Only called after evaluate() returned "allow" AND verify_permit()
    # confirmed the issued permit. `permit` is the VerifiedPermit.
    return await run_deploy(permit_id=permit.token)

result = await enforce.run(
    RunRequest(request={"action_type": "deploy", "actor_id": "svc:deploy-bot"}, execute=deploy)
)

if result.decision == "allow":
    print(result.value)
else:
    print(f"blocked: {result.decision} ({result.reason_code})")
```

There is no `evaluate`-only entry point on `Enforce` — to evaluate
without executing, use the v1 client (`atlasent` package) directly.
`Enforce` is specifically for gated execution.

## API

### `Enforce(*, client, bindings, fail_closed, latency_budget_ms=None, latency_breach_mode="deny", on_latency_breach=None)`

| Parameter | Type | Description |
|---|---|---|
| `client` | `EnforceCompatibleClient` | Object exposing `async evaluate(dict) -> EvaluateResponse` and `async verify_permit(str) -> VerifiedPermit` |
| `bindings` | `Bindings` | `org_id` / `actor_id` / `action_type` the issued permit must match |
| `fail_closed` | `bool` | Must be `True`. Passing `False` raises `DisallowedConfigError` — fail-closed is not configurable |
| `latency_budget_ms` | `int \| None` | Optional timeout for the `verify_permit` call |
| `latency_breach_mode` | `"deny" \| "warn"` | On budget breach: deny immediately, or call `on_latency_breach` and keep waiting |
| `on_latency_breach` | `Callable[[], None] \| None` | Called once if `latency_breach_mode="warn"` and the budget is breached |

### `await Enforce.run(request: RunRequest[T]) -> RunResult[T]`

`RunRequest(request: dict, execute: Callable[[VerifiedPermit], Awaitable[T]])`.
`execute` runs only when `evaluate` returns `allow` with a permit token
*and* `verify_permit` confirms it against `bindings`.

`RunResult(decision, value=None, permit=None, reason_code=None)`:

- `decision` — `"allow"`, `"deny"`, `"hold"`, or `"escalate"`.
- `value` — the return value of `execute`, set only on `allow`.
- `permit` — the `VerifiedPermit` used, set only on `allow`.
- `reason_code` — a `ReasonCode` explaining a non-`allow` result (see below).

## Failure modes (all fail closed)

| Scenario | `decision` | `reason_code` |
|---|---|---|
| `evaluate` returns `deny` / `hold` / `escalate` | passthrough | from server |
| `evaluate` raises (4xx) | `deny` | `evaluate_client_error` |
| `evaluate` raises (5xx / timeout) | `deny` | `evaluate_unavailable` |
| `verify_permit` raises (4xx) | `deny` | `verify_client_error` |
| `verify_permit` raises (5xx / timeout) | `deny` | `verify_unavailable` |
| `verify_permit` exceeds `latency_budget_ms` (`latency_breach_mode="deny"`) | `deny` | `verify_latency_breach` |
| Verified permit's `org_id`/`actor_id`/`action_type` != `bindings` | `deny` | `binding_mismatch` |
| Permit expired / consumed / revoked / not found | `deny` | `permit_expired` / `permit_consumed` / `permit_revoked` / `permit_not_found` |

`execute` raising propagates the caller's exception unmodified.

## License

Apache-2.0 — see [LICENSE](https://github.com/AtlaSent-Systems-Inc/atlasent-sdk/blob/main/LICENSE)
