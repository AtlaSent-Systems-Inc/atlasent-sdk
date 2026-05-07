"""Basic authorization example — the fail-closed primitive.

``protect()`` is the canonical end-to-end gate: it evaluates the
action AND verifies the resulting permit. On allow, returns a
:class:`~atlasent.Permit`; on policy denial, raises
:class:`~atlasent.AtlaSentDeniedError`; on transport / auth / server
error, raises :class:`~atlasent.AtlaSentError`. There is no
``permitted=False`` return path — if ``protect()`` returns, the
action is authorized.

Before running, set your API key::

    export ATLASENT_API_KEY=ask_live_...
"""

from atlasent import AtlaSentDeniedError, AtlaSentError, protect

try:
    permit = protect(
        agent="my-agent",
        action="read_patient_record",
        context={"patient_id": "PT-2024-001"},
    )
except AtlaSentDeniedError as exc:
    print(f"Denied: {exc.reason}")
    print(f"  evaluation_id: {exc.evaluation_id}")
    raise SystemExit(1) from exc
except AtlaSentError as exc:
    # Transport / auth / server failure. Fail-closed.
    print(f"Authorization unavailable: {exc.message}")
    raise SystemExit(2) from exc

# If we got here, the action is authorized end-to-end.
print(f"Permitted: {permit.reason}")
print(f"  permit_id:   {permit.permit_id}")
print(f"  permit_hash: {permit.permit_hash}")
print(f"  audit_hash:  {permit.audit_hash}")
