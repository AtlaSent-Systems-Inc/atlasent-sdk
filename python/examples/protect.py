"""One-line execution-time authorization with `atlasent.protect`.

`protect` is fail-closed: if the action is authorized end-to-end,
it returns a verified `Permit`. If anything else happens — policy
denial, permit revoked, network error, rate limit — it raises, and
the action simply cannot execute. This is the category boundary:
there is no `result.permitted is False` branch to forget.

Run with:
    ATLASENT_API_KEY=ask_live_... python examples/protect.py
"""

from __future__ import annotations

import logging
import os
import sys

from atlasent import AtlaSentDeniedError, AtlaSentError, protect

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)


def deploy(commit: str, approver: str) -> None:
    try:
        permit = protect(
            agent="deploy-bot",
            action="deploy_to_production",
            context={"commit": commit, "approver": approver},
        )
    except AtlaSentDeniedError as exc:
        # Policy said no (or the permit failed verification).
        log.error(
            "Deploy blocked: %s (decision=%s, evaluation_id=%s, audit_hash=%s)",
            exc.reason or exc.decision,
            exc.decision,
            exc.evaluation_id,
            exc.audit_hash,
        )
        sys.exit(1)
    except AtlaSentError as exc:
        # Transport / auth / server failure. Fail-closed: do not deploy.
        log.error(
            "AtlaSent unavailable (code=%s, status=%s): %s",
            exc.code,
            exc.status_code,
            exc.message,
        )
        sys.exit(2)

    log.info(
        "Deploy approved — permit_id=%s audit_hash=%s",
        permit.permit_id,
        permit.audit_hash,
    )
    # run_deploy(commit)


if __name__ == "__main__":
    deploy(
        commit=os.environ.get("GIT_SHA", "HEAD"),
        approver=os.environ.get("APPROVER", os.environ.get("USER", "unknown")),
    )
