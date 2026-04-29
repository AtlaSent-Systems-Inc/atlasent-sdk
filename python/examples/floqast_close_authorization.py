#!/usr/bin/env python3
"""atlasent-floqast-pilot: Accounting Close Authorization Demo

Demonstrates non-bypassable authorization for the five protected actions
in an accounting close workflow, using the AtlaSent SDK's fail-closed
enforcement model.

Protected actions
  close_task.complete      -- task must carry a verified permit before completion
  reconciliation.certify   -- certifier must be on the authorized controller list;
                              dual-approval enforced when required
  journal_entry.approve    -- JEs above $100k escalate to a CFO hold state
  adjustment.submit        -- submitter must be on the authorized submitter list
  period.close             -- requires all tasks complete AND CFO sign-off

Scenarios
  1   close_task.complete      BLOCKED: missing context fields
  2   reconciliation.certify   ALLOWED: full context -> permit -> audit record
  3   journal_entry.approve    HOLD -> CFO approval -> permit -> execution
  4   adjustment.submit        BLOCKED: unauthorized submitter
  4b  adjustment.submit        ALLOWED: authorized submitter
  5   period.close             BLOCKED: outstanding tasks
  5b  period.close             HOLD -> CFO sign-off -> permit -> execution

Modes
  Offline (default):  python examples/floqast_close_authorization.py
  Live API:           ATLASENT_API_KEY=ask_live_... python examples/floqast_close_authorization.py
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from atlasent import AtlaSentClient, AtlaSentDeniedError, configure
from atlasent.models import Permit, RateLimitState


# ---------------------------------------------------------------------------
# Demo constants
# ---------------------------------------------------------------------------

PERIOD = "Q1-2026"
AUTHORIZED_CONTROLLERS: frozenset[str] = frozenset(
    {"alice.chen@acme.com", "bob.smith@acme.com"}
)
AUTHORIZED_SUBMITTERS: frozenset[str] = frozenset(
    {"alice.chen@acme.com", "carol.jones@acme.com"}
)
HIGH_VALUE_THRESHOLD = 100_000  # USD -- JEs above this require CFO approval

WIDTH = 72


# ---------------------------------------------------------------------------
# Audit record
# ---------------------------------------------------------------------------


@dataclass
class AuditRecord:
    """One entry in the hash-linked immutable audit chain."""

    event_id: str
    timestamp: str
    actor: str
    action: str
    decision: str
    permit_id: str
    audit_hash: str
    previous_hash: str
    reason: str
    context_snapshot: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# In-process stub engine
# ---------------------------------------------------------------------------


class _FloQastStub(AtlaSentClient):
    """In-process stub for the FloQast pilot -- no HTTP calls.

    Overrides ``_request`` so every ``protect()`` call is handled by a
    deterministic local policy engine instead of the AtlaSent API.  The
    stub accumulates a hash-linked audit chain identical in shape to what
    the hosted engine emits.

    Use :meth:`grant_approval` to simulate a human approving a held
    action inside the AtlaSent console.
    """

    def __init__(self) -> None:
        # Initialise the parent with a dummy key; httpx.Client is created but
        # never used because _request is fully overridden.
        super().__init__("demo-stub", base_url="http://stub.local")
        self._granted_approvals: set[str] = set()
        self._decisions: dict[str, dict[str, Any]] = {}
        self._audit_chain: list[AuditRecord] = []

    # -- public demo helpers ------------------------------------------------

    def grant_approval(self, key: str) -> None:
        """Simulate a human granting a held approval in the AtlaSent console."""
        self._granted_approvals.add(key)
        print(f"  [console] approval granted for hold_key={key!r}")

    @property
    def audit_chain(self) -> list[AuditRecord]:
        return list(self._audit_chain)

    # -- transport override -------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None,
        *,
        params: dict[str, str] | None = None,
    ) -> tuple[dict[str, Any], RateLimitState | None, str]:
        rid = uuid.uuid4().hex[:12]
        p = payload or {}
        if path == "/v1-evaluate":
            return self._handle_evaluate(p), None, rid
        if path == "/v1-verify-permit":
            return self._handle_verify(p), None, rid
        return {}, None, rid

    # -- evaluate / verify --------------------------------------------------

    def _handle_evaluate(self, payload: dict[str, Any]) -> dict[str, Any]:
        action = payload.get("action", "")
        agent = payload.get("agent", "")
        context = payload.get("context", {})

        result = self._decide(action, agent, context)
        permit_id = f"pt_{uuid.uuid4().hex[:16]}"
        result["decision_id"] = permit_id
        result["_meta"] = {"action": action, "agent": agent, "context": context}
        self._decisions[permit_id] = result
        return result

    def _handle_verify(self, payload: dict[str, Any]) -> dict[str, Any]:
        permit_id = payload.get("decision_id", "")
        stored = self._decisions.get(permit_id, {})
        permitted = bool(stored.get("permitted"))
        ts = datetime.now(timezone.utc).isoformat()

        if not permitted:
            return {
                "verified": False,
                "permit_hash": "",
                "outcome": "invalid",
                "timestamp": ts,
            }

        meta = stored.get("_meta", {})
        prev = self._audit_chain[-1].audit_hash if self._audit_chain else ""
        blob = json.dumps(
            {
                "permit_id": permit_id,
                "action": meta.get("action"),
                "agent": meta.get("agent"),
                "reason": stored.get("reason", ""),
                "previous_hash": prev,
            },
            sort_keys=True,
        )
        audit_hash = hashlib.sha256(blob.encode()).hexdigest()[:32]
        permit_hash = hashlib.sha256(permit_id.encode()).hexdigest()[:32]

        self._audit_chain.append(
            AuditRecord(
                event_id=f"evt_{uuid.uuid4().hex[:12]}",
                timestamp=ts,
                actor=meta.get("agent", ""),
                action=meta.get("action", ""),
                decision="allow",
                permit_id=permit_id,
                audit_hash=audit_hash,
                previous_hash=prev,
                reason=stored.get("reason", ""),
                context_snapshot=meta.get("context", {}),
            )
        )
        return {
            "verified": True,
            "permit_hash": permit_hash,
            "outcome": "verified",
            "timestamp": ts,
        }

    # -- stub policy engine -------------------------------------------------

    def _decide(
        self, action: str, agent: str, ctx: dict[str, Any]
    ) -> dict[str, Any]:
        """Apply stub policy rules for the five accounting close actions."""

        def allow(reason: str) -> dict[str, Any]:
            return {
                "permitted": True,
                "reason": reason,
                "audit_hash": uuid.uuid4().hex[:32],
            }

        def deny(reason: str, hold_key: str = "") -> dict[str, Any]:
            # Encode the hold key in the reason so the demo runner can detect
            # holds from the AtlaSentDeniedError.reason string.
            tag = f" [hold:{hold_key}]" if hold_key else ""
            return {"permitted": False, "reason": reason + tag, "audit_hash": ""}

        # -- close_task.complete --------------------------------------------
        if action == "close_task.complete":
            if not ctx.get("task_id"):
                return deny("missing required field: task_id")
            if not ctx.get("completed_by"):
                return deny("missing required field: completed_by")
            if ctx.get("period") != PERIOD:
                return deny(
                    f"period mismatch: expected {PERIOD!r}, "
                    f"got {ctx.get('period')!r}"
                )
            return allow(
                f"close task {ctx['task_id']} authorized for {PERIOD}"
            )

        # -- reconciliation.certify -----------------------------------------
        if action == "reconciliation.certify":
            if not ctx.get("account_id"):
                return deny("missing required field: account_id")
            certifier = ctx.get("certified_by", "")
            if certifier not in AUTHORIZED_CONTROLLERS:
                return deny(
                    f"'{certifier}' is not on the authorized controller list"
                )
            if ctx.get("dual_approval_required") and not ctx.get("second_approver"):
                return deny(
                    "dual approval required but second_approver not provided"
                )
            return allow(
                f"reconciliation for {ctx['account_id']} "
                f"certified by {certifier}"
            )

        # -- journal_entry.approve ------------------------------------------
        if action == "journal_entry.approve":
            if not ctx.get("je_id"):
                return deny("missing required field: je_id")
            amount = float(ctx.get("amount", 0))
            hold_key = f"je_cfo:{ctx['je_id']}"
            if (
                amount > HIGH_VALUE_THRESHOLD
                and hold_key not in self._granted_approvals
            ):
                return deny(
                    f"JE {ctx['je_id']} (${amount:,.0f}) exceeds "
                    f"${HIGH_VALUE_THRESHOLD:,.0f} delegation limit -- "
                    f"CFO approval required",
                    hold_key=hold_key,
                )
            return allow(
                f"journal entry {ctx['je_id']} approved (${amount:,.0f})"
            )

        # -- adjustment.submit ----------------------------------------------
        if action == "adjustment.submit":
            if not ctx.get("adjustment_id"):
                return deny("missing required field: adjustment_id")
            submitter = ctx.get("submitted_by", "")
            if submitter not in AUTHORIZED_SUBMITTERS:
                return deny(
                    f"'{submitter}' is not authorized to submit "
                    f"period adjustments"
                )
            return allow(
                f"adjustment {ctx['adjustment_id']} submitted "
                f"by authorized user ({submitter})"
            )

        # -- period.close ---------------------------------------------------
        if action == "period.close":
            period = ctx.get("period", "")
            if not period:
                return deny("missing required field: period")
            if not ctx.get("all_tasks_complete"):
                n = ctx.get("incomplete_task_count", "unknown number of")
                return deny(
                    f"period {period}: {n} outstanding close tasks remain"
                )
            hold_key = f"period_close_cfo:{period}"
            if (
                not ctx.get("cfo_sign_off")
                and hold_key not in self._granted_approvals
            ):
                return deny(
                    f"period {period} close requires CFO sign-off",
                    hold_key=hold_key,
                )
            return allow(
                f"period {period} close authorized -- all conditions satisfied"
            )

        return deny(f"action '{action}' not registered in accounting close policy")


# ---------------------------------------------------------------------------
# Display helpers
# ---------------------------------------------------------------------------


def _bar(title: str = "") -> None:
    if title:
        print(f"\n{'━' * WIDTH}")
        print(f"  {title}")
        print(f"{'━' * WIDTH}")
    else:
        print(f"  {'─' * (WIDTH - 4)}")


def _scenario(num: int | str, action: str, note: str) -> None:
    label = f"Scenario {num} — {action}"
    print(f"\n▸ {label}")
    print(f"  {note}")


def _blocked(reason: str) -> None:
    clean = re.sub(r"\s*\[hold:[^\]]+\]", "", reason)
    print(f"  ✗ BLOCKED    {clean}")


def _hold(reason: str, hold_key: str) -> None:
    clean = re.sub(r"\s*\[hold:[^\]]+\]", "", reason)
    print(f"  ⏸ HOLD       {clean}")
    print(f"               hold_key: {hold_key}")


def _permit_line(p: Permit) -> None:
    print(f"  ✔ PERMITTED  {p.reason}")
    print(f"               permit_id:   {p.permit_id}")
    print(f"               audit_hash:  {p.audit_hash}")
    print(f"               permit_hash: {p.permit_hash}")
    if p.timestamp:
        print(f"               timestamp:   {p.timestamp}")


def _execute(msg: str) -> None:
    print(f"               → {msg}")


def _parse_hold_key(reason: str) -> str:
    m = re.search(r"\[hold:([^\]]+)\]", reason)
    return m.group(1) if m else ""


# ---------------------------------------------------------------------------
# Simulated accounting system operations
# In production these would be real DB writes / calls to the accounting API.
# They are only reachable after protect() returns a verified Permit.
# ---------------------------------------------------------------------------


def _sys_complete_task(task_id: str, completed_by: str, period: str) -> None:
    _execute(
        f"task {task_id} marked COMPLETE in {period} close checklist "
        f"(by {completed_by})"
    )


def _sys_certify_reconciliation(account_id: str, certified_by: str) -> None:
    _execute(f"reconciliation for {account_id} set to CERTIFIED by {certified_by}")


def _sys_approve_journal_entry(je_id: str, amount: float) -> None:
    _execute(f"JE {je_id} (${amount:,.0f}) moved to APPROVED state")


def _sys_submit_adjustment(adj_id: str, submitted_by: str) -> None:
    _execute(f"adjustment {adj_id} submitted by {submitted_by}")


def _sys_close_period(period: str) -> None:
    _execute(
        f"period {period} set to CLOSED -- "
        f"no further postings accepted"
    )


# ---------------------------------------------------------------------------
# Demo runner
# ---------------------------------------------------------------------------


def run_demo(client: AtlaSentClient, stub: _FloQastStub | None) -> None:  # noqa: C901
    _bar(
        "atlasent-floqast-pilot   "
        "Accounting Close Authorization Demo"
    )
    if stub:
        print(f"  mode: offline (in-process stub engine)")
    else:
        print(f"  mode: live (AtlaSent API)")
    print(f"  period: {PERIOD}")

    # -----------------------------------------------------------------------
    # Scenario 1: close_task.complete -- BLOCKED (missing context)
    # -----------------------------------------------------------------------
    _scenario(1, "close_task.complete", "BLOCKED: missing context fields")
    try:
        client.protect(
            agent="close-automation",
            action="close_task.complete",
            context={
                # task_id, completed_by, and period are all absent
                "source": "automated-close-bot",
            },
        )
        print("  (unexpected: permit issued)")
    except AtlaSentDeniedError as exc:
        _blocked(exc.reason)
        print(f"               evaluation_id: {exc.evaluation_id}")
        print(f"               → task NOT marked complete")

    # -----------------------------------------------------------------------
    # Scenario 2: reconciliation.certify -- ALLOWED (full context)
    # -----------------------------------------------------------------------
    _scenario(
        2,
        "reconciliation.certify",
        "ALLOWED: full context -> verified permit -> audit record",
    )
    try:
        p = client.protect(
            agent="alice.chen@acme.com",
            action="reconciliation.certify",
            context={
                "account_id": "CASH-1000",
                "certified_by": "alice.chen@acme.com",
                "period": PERIOD,
                "balance_difference": 0.00,
                "dual_approval_required": False,
            },
        )
        _permit_line(p)
        _sys_certify_reconciliation("CASH-1000", "alice.chen@acme.com")
    except AtlaSentDeniedError as exc:
        _blocked(exc.reason)

    # -----------------------------------------------------------------------
    # Scenario 3: journal_entry.approve -- HOLD -> approval -> ALLOWED
    # -----------------------------------------------------------------------
    _scenario(
        3,
        "journal_entry.approve",
        "HOLD: high-value JE ($250k) -> CFO approval -> permit -> execution",
    )
    je_id = "JE-2026-4821"
    amount = 250_000.00
    je_ctx = {"je_id": je_id, "amount": amount, "period": PERIOD}

    hold_key_3 = ""
    try:
        p = client.protect(
            agent="controller-bot",
            action="journal_entry.approve",
            context=je_ctx,
        )
        _permit_line(p)
        _sys_approve_journal_entry(je_id, amount)
    except AtlaSentDeniedError as exc:
        hold_key_3 = _parse_hold_key(exc.reason)
        if hold_key_3:
            _hold(exc.reason, hold_key_3)
        else:
            _blocked(exc.reason)

    if hold_key_3 and stub:
        print()
        print("  [human] CFO reviews in AtlaSent console and approves")
        stub.grant_approval(hold_key_3)
        print()
        try:
            p = client.protect(
                agent="controller-bot",
                action="journal_entry.approve",
                context=je_ctx,
            )
            _permit_line(p)
            _sys_approve_journal_entry(je_id, amount)
        except AtlaSentDeniedError as exc:
            _blocked(exc.reason)

    # -----------------------------------------------------------------------
    # Scenario 4: adjustment.submit -- BLOCKED (unauthorized submitter)
    # -----------------------------------------------------------------------
    _scenario(
        4,
        "adjustment.submit",
        "BLOCKED: submitter (dave.ops) not on authorized list",
    )
    try:
        client.protect(
            agent="dave.ops@acme.com",
            action="adjustment.submit",
            context={
                "adjustment_id": "ADJ-2026-009",
                "submitted_by": "dave.ops@acme.com",
                "period": PERIOD,
                "amount": 1_500.00,
            },
        )
        print("  (unexpected: permit issued)")
    except AtlaSentDeniedError as exc:
        _blocked(exc.reason)
        print(f"               → adjustment NOT submitted")

    # -----------------------------------------------------------------------
    # Scenario 4b: adjustment.submit -- ALLOWED (authorized submitter)
    # -----------------------------------------------------------------------
    _scenario(
        "4b",
        "adjustment.submit",
        "ALLOWED: authorized submitter (carol.jones)",
    )
    try:
        p = client.protect(
            agent="carol.jones@acme.com",
            action="adjustment.submit",
            context={
                "adjustment_id": "ADJ-2026-009",
                "submitted_by": "carol.jones@acme.com",
                "period": PERIOD,
                "amount": 1_500.00,
            },
        )
        _permit_line(p)
        _sys_submit_adjustment("ADJ-2026-009", "carol.jones@acme.com")
    except AtlaSentDeniedError as exc:
        _blocked(exc.reason)

    # -----------------------------------------------------------------------
    # Scenario 5: period.close -- BLOCKED (outstanding tasks)
    # -----------------------------------------------------------------------
    _scenario(
        5,
        "period.close",
        "BLOCKED: outstanding close tasks remain",
    )
    try:
        client.protect(
            agent="cfo-bot",
            action="period.close",
            context={
                "period": PERIOD,
                "all_tasks_complete": False,
                "incomplete_task_count": 3,
            },
        )
        print("  (unexpected: permit issued)")
    except AtlaSentDeniedError as exc:
        _blocked(exc.reason)
        print(f"               → period NOT closed")

    # -----------------------------------------------------------------------
    # Scenario 5b: period.close -- HOLD -> CFO sign-off -> ALLOWED
    # -----------------------------------------------------------------------
    _scenario(
        "5b",
        "period.close",
        "HOLD: tasks complete, missing CFO sign-off -> approval -> permit",
    )
    period_ctx = {"period": PERIOD, "all_tasks_complete": True}
    hold_key_5 = ""
    try:
        p = client.protect(
            agent="cfo-bot",
            action="period.close",
            context=period_ctx,
        )
        _permit_line(p)
        _sys_close_period(PERIOD)
    except AtlaSentDeniedError as exc:
        hold_key_5 = _parse_hold_key(exc.reason)
        if hold_key_5:
            _hold(exc.reason, hold_key_5)
        else:
            _blocked(exc.reason)

    if hold_key_5 and stub:
        print()
        print("  [human] CFO signs off in AtlaSent console")
        stub.grant_approval(hold_key_5)
        print()
        try:
            p = client.protect(
                agent="cfo-bot",
                action="period.close",
                context=period_ctx,
            )
            _permit_line(p)
            _sys_close_period(PERIOD)
        except AtlaSentDeniedError as exc:
            _blocked(exc.reason)

    # -----------------------------------------------------------------------
    # Audit trail
    # -----------------------------------------------------------------------
    if stub:
        chain = stub.audit_chain
        _bar(
            f"Audit Trail   "
            f"{len(chain)} permitted action(s)   "
            f"immutable hash-linked chain"
        )
        if not chain:
            print("  (no permitted actions recorded)")
        for i, rec in enumerate(chain):
            print(f"  [{i + 1}] {rec.timestamp}")
            print(f"      action:       {rec.action}")
            print(f"      actor:        {rec.actor}")
            print(f"      decision:     {rec.decision}")
            print(f"      permit_id:    {rec.permit_id}")
            print(f"      audit_hash:   {rec.audit_hash}")
            print(
                f"      prev_hash:    "
                f"{rec.previous_hash if rec.previous_hash else '(genesis)'}"
            )
            print(f"      reason:       {rec.reason}")
            if i < len(chain) - 1:
                print()
        if chain:
            print()
            print(f"  chain length : {len(chain)} events")
            print(f"  head hash    : {chain[-1].audit_hash}")

    _bar()
    print(f"  Demo complete.")
    print(f"  Enforcement summary:")
    print(f"    BLOCKED  2 actions (missing context / unauthorized actor)")
    print(f"    HOLD     2 actions (CFO approval required)")
    print(f"    ALLOWED  3 actions (all permit-verified before execution)")
    print()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
    api_key = os.environ.get("ATLASENT_API_KEY", "")
    if api_key:
        configure(api_key=api_key)
        # Use a plain client; hold-approval simulation requires the stub.
        from atlasent.authorize import _get_default_client  # noqa: PLC2701

        client = _get_default_client()
        stub: _FloQastStub | None = None
    else:
        stub = _FloQastStub()
        client = stub

    run_demo(client, stub)


if __name__ == "__main__":
    main()
