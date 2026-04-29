"""``atlasent.with_permit`` — verify-before-run wrapper (sync).

Python mirror of the TypeScript SDK's ``withPermit(req, fn)``. The
single-call execution-time authorization boundary, lifted one level
higher than :func:`atlasent.protect`. Where ``protect()`` returns a
verified :class:`~atlasent.models.Permit` and leaves the caller to
run their own action, ``with_permit()`` orchestrates the entire
lifecycle:

    1. evaluate the request → raise
       :class:`~atlasent.exceptions.AtlaSentDeniedError` on anything
       other than ALLOW.
    2. verify the resulting permit → raise on ``verified is False``
       (covers v1 single-use semantics: a permit consumed by an
       earlier verify reports ``verified: false`` on a replay).
    3. invoke ``fn`` with the verified permit.
    4. return ``fn``'s result.

The action cannot run unless steps 1 and 2 succeed. If ``fn`` raises,
the exception propagates — the permit is already consumed by step 2
in v1, so there is no compensating revoke.

::

    from atlasent import with_permit

    result = with_permit(
        agent="deploy-bot",
        action="deploy_to_production",
        context={"commit": commit, "approver": approver},
        fn=lambda permit: do_deploy(commit, permit_id=permit.permit_token),
    )

Replay protection: in v1 the server consumes a permit on first
``verify_permit``. A second verify on the same permit id returns
``verified: false``, which raises here. This guarantees ``fn`` cannot
be invoked twice for the same permit even if a caller stashed and
re-used the request — the second ``with_permit`` call would raise
before reaching ``fn``.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, TypeVar

from .authorize import protect
from .models import Permit

T = TypeVar("T")


def with_permit(
    *,
    agent: str,
    action: str,
    context: dict[str, Any] | None = None,
    fn: Callable[[Permit], T],
) -> T:
    """Authorize a request and run ``fn`` only on verified permit.

    Args:
        agent: Same semantics as :func:`atlasent.protect.agent`.
        action: Same semantics as :func:`atlasent.protect.action`.
        context: Optional context dict; same semantics as
            :func:`atlasent.protect.context`.
        fn: Callable invoked with the verified
            :class:`~atlasent.models.Permit`. Its return value is
            propagated back to the caller.

    Returns:
        Whatever ``fn`` returns.

    Raises:
        AtlaSentDeniedError: Policy denied, hold/escalate, or permit
            failed verification (including the v1 replay case where the
            server reports ``permit_consumed``). ``fn`` is never invoked.
        AtlaSentError: Transport, timeout, auth, rate-limit, or server
            error. ``fn`` is never invoked.

    Errors raised by ``fn`` itself propagate untouched.
    """
    # Reuse `protect` for the evaluate + verify pair so the two paths
    # never drift in fail-closed semantics or error taxonomy. If
    # `protect` ever grows new pre-action checks, `with_permit` picks
    # them up for free.
    permit = protect(agent=agent, action=action, context=context)
    return fn(permit)
