# `atlasent-enforce` (skeleton)

Non-bypassable execution wrapper for the AtlaSent SDK. Forces
`verify-permit` on every gated action and fails closed on any error.

> **Status: skeleton, no implementation.** This package installs and
> exposes typed surfaces, but `Enforce.run()` raises
> `NotImplementedError`. Implementation lands gated behind
> SIM-01..SIM-10 — see `contract/SIM_SCENARIOS.md`.

Spec: [`contract/ENFORCE_PACK.md`](../../contract/ENFORCE_PACK.md).

## Surface (planned)

```python
from atlasent_enforce import Enforce, Bindings, RunRequest
from atlasent import AtlasentClient   # v1

enforce = Enforce(
    client=AtlasentClient(api_key=..., base_url=...),
    bindings=Bindings(org_id=..., actor_id=..., action_type="deploy"),
    fail_closed=True,                  # non-toggleable
)

result = await enforce.run(
    RunRequest(
        request={...},                 # CDO inputs
        execute=lambda permit: do_the_thing(permit),
    ),
)
```

## Why a separate package

The v1 SDK (`atlasent` on PyPI) is locked at GA. Enforce is a net-new
package so we can iterate on the wrapper contract without any risk of
regressing v1 callers.

## Local development

```bash
cd python/atlasent_enforce
pip install -e '.[dev]'
pytest                # smoke tests only until SIM fixtures land
ruff check .
```
