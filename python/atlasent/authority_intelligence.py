"""Authority Intelligence client for the AtlaSent Python SDK.

Thin wrapper over the ``v1-authority-intelligence`` edge function. This module
exposes exactly one of its sub-routes today:

===================================================  =================
Sub-route                                            SDK method
===================================================  =================
``GET /v1-authority-intelligence/integrity-audit``   ``integrity_audit``
``GET /v1-authority-intelligence/sod-eligibility``   *not wrapped yet*
``GET /v1-authority-intelligence/blast-radius``      *not wrapped yet*
``GET /v1-authority-intelligence/explain-authority`` *not wrapped yet*
===================================================  =================

The three unwrapped siblings are deliberately out of scope; the class is left
open so they can be added without a breaking change.

Note ``explain-authority`` IS wrapped elsewhere in this SDK — as the flat
:meth:`AtlaSentClient.explain_authority`, landed concurrently (#462), and
against the *slash* path form ``/v1/authority-intelligence/explain-authority``
rather than the hyphenated form used here. Both path conventions exist in this
SDK today (``/v1-evaluate`` vs ``/v1/sso/*``), and each route was specified
with the form its own method uses. Reconciling them — and deciding whether
``explain_authority`` should move onto this client — is a follow-up, not
something to harmonize silently.

Auth: API key (``ask_live_*`` / ``ask_test_*``) carrying the
``authority_intelligence:read`` scope. The organization is derived
**server-side** from the authenticated key — there is no client-supplied
``organization_id`` parameter on this route.

Usage::

    from atlasent import AtlaSentClient

    client = AtlaSentClient(api_key="ask_live_...")

    report = client.authority_intelligence.integrity_audit()
    for finding in report.findings:
        print(finding.classification, finding.severity, finding.reason)
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .client import AtlaSentClient


#: Wire path of the integrity-audit sub-route.
INTEGRITY_AUDIT_PATH = "/v1-authority-intelligence/integrity-audit"

#: The three classifications the wire enum carries today. The SDK does **not**
#: validate against this set — an unrecognized value passes through verbatim.
#: It exists so :func:`count_findings_by_classification` can zero-fill all
#: three, which is what keeps the distinction visible when a count is 0.
KNOWN_CLASSIFICATIONS: tuple[str, str, str] = (
    "defect",
    "non_exercisable",
    "unresolved",
)

#: The severities the wire enum carries today. Advisory only — not validated.
KNOWN_SEVERITIES: tuple[str, ...] = ("critical", "high", "medium", "low", "info")


# ── Wire types ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class IntegrityFinding:
    """A single integrity finding.

    Field names mirror the runtime wire shape verbatim (snake_case), matching
    the convention used by :mod:`atlasent.runtime_v2`. Audit-evidence
    vocabulary is not renamed or reinterpreted client-side.

    ``classification`` is three-way and the distinction is **load-bearing** —
    this is compliance/audit evidence, not a health check:

    * ``defect`` — something is wrong and should be fixed.
    * ``non_exercisable`` — the authority cannot be exercised. This is
      frequently the *correct*, healthy state, not a problem.
    * ``unresolved`` — the audit could not determine which of the above
      applies. It must never be silently treated as clean.

    The field is typed ``str`` and never validated: a future fourth value
    passes through as a plain string rather than raising.
    """

    finding_type: str
    classification: str
    severity: str
    subject_id: str | None
    source_table: str | None
    source_id: str | None
    related_source_ids: tuple[str, ...]
    effective_at: str | None
    evidence_posture: str
    reason: str


@dataclass(frozen=True)
class IntegrityReport:
    """The full report returned by the integrity-audit sub-route.

    ``summary`` is an open-ended mapping (it carries ``audited_scope`` —
    including the window the server actually applied — plus counts by
    classification and severity). Its keys are deliberately **not** modelled as
    fixed attributes; the server may add to it. Same for ``nodes`` and
    ``edges``.
    """

    schema_version: str
    query: str
    organization_id: str
    evaluated_at: str
    produced_by: tuple[str, ...] = ()
    summary: dict[str, Any] = field(default_factory=dict)
    findings: tuple[IntegrityFinding, ...] = ()
    nodes: tuple[dict[str, Any], ...] = ()
    edges: tuple[dict[str, Any], ...] = ()


# ── Parsing ───────────────────────────────────────────────────────────────────


def _parse_finding(data: dict[str, Any]) -> IntegrityFinding:
    """Map one wire finding onto :class:`IntegrityFinding` without validating.

    No value vocabulary is checked, normalized, or rejected — an unrecognized
    ``classification`` / ``severity`` / ``evidence_posture`` is carried through
    exactly as the server sent it.
    """
    return IntegrityFinding(
        finding_type=str(data.get("finding_type", "")),
        classification=str(data.get("classification", "")),
        severity=str(data.get("severity", "")),
        subject_id=data.get("subject_id"),
        source_table=data.get("source_table"),
        source_id=data.get("source_id"),
        related_source_ids=tuple(data.get("related_source_ids") or ()),
        effective_at=data.get("effective_at"),
        evidence_posture=str(data.get("evidence_posture", "")),
        reason=str(data.get("reason", "")),
    )


def _parse_report(data: dict[str, Any]) -> IntegrityReport:
    return IntegrityReport(
        schema_version=str(data.get("schema_version", "")),
        query=str(data.get("query", "")),
        organization_id=str(data.get("organization_id", "")),
        evaluated_at=str(data.get("evaluated_at", "")),
        produced_by=tuple(data.get("produced_by") or ()),
        summary=dict(data.get("summary") or {}),
        findings=tuple(_parse_finding(f) for f in (data.get("findings") or ())),
        nodes=tuple(data.get("nodes") or ()),
        edges=tuple(data.get("edges") or ()),
    )


# ── Convenience ───────────────────────────────────────────────────────────────


def count_findings_by_classification(report: IntegrityReport) -> dict[str, int]:
    """Count a report's findings by ``classification``.

    This is deliberately **not** a pass/fail summary. There is no ``is_healthy``
    / ``has_errors`` convenience anywhere in this module, and none should be
    added: a ``non_exercisable`` finding is frequently the correct, healthy
    state, and an ``unresolved`` finding must never be silently treated as
    clean. Collapsing the three-way classification to a boolean would
    misrepresent the evidence.

    All three known classifications are always present (``0`` when none
    matched), so a caller can read them without a ``get()`` guard. Any
    unrecognized classification appears as an additional key rather than being
    dropped or folded into one of the three::

        counts = count_findings_by_classification(report)
        if counts["unresolved"]:
            # The audit could not resolve these — escalate, never treat as clean.
            ...
    """
    counts: dict[str, int] = dict.fromkeys(KNOWN_CLASSIFICATIONS, 0)
    counts.update(Counter(f.classification for f in report.findings))
    return counts


# ── Client ────────────────────────────────────────────────────────────────────


class AuthorityIntelligenceClient:
    """Sub-client for the ``v1-authority-intelligence`` read-only routes.

    Obtain via the attribute on :class:`~atlasent.client.AtlaSentClient`::

        client = AtlaSentClient(api_key="ask_live_...")
        report = client.authority_intelligence.integrity_audit()

    or construct it directly around an existing client::

        from atlasent.authority_intelligence import AuthorityIntelligenceClient

        ai = AuthorityIntelligenceClient(client)
    """

    def __init__(self, client: AtlaSentClient) -> None:
        self._c = client

    def integrity_audit(
        self,
        *,
        decision_window_days: int | None = None,
    ) -> IntegrityReport:
        """``GET /v1-authority-intelligence/integrity-audit``.

        Runs the authority integrity audit for the authenticated caller's
        organization and returns the full :class:`IntegrityReport`.

        The server **fails closed**: it never returns a partial or degraded
        report. A 5xx means the audit could not complete and augmentation was
        refused; that propagates as an
        :class:`~atlasent.exceptions.AtlaSentError` (carrying ``status_code``
        and ``code``) from the shared transport, exactly like every other
        endpoint in this SDK. Do not read a raised error as "no findings".

        :param decision_window_days: Size of the decision window to audit, in
            days (integer, 1–3650). Omit it and **no** ``decision_window_days``
            query parameter is sent at all, letting the server apply its own
            default. The SDK never guesses or substitutes a default of its own
            — the window actually applied is echoed back in
            ``report.summary["audited_scope"]``.
        """
        params: dict[str, str] | None = None
        if decision_window_days is not None:
            params = {"decision_window_days": str(decision_window_days)}

        data, _, _ = self._c._get(INTEGRITY_AUDIT_PATH, params=params)  # noqa: SLF001
        return _parse_report(data)


def authority_intelligence(client: AtlaSentClient) -> AuthorityIntelligenceClient:
    """Return an :class:`AuthorityIntelligenceClient` bound to ``client``.

    Mirrors :func:`atlasent.runtime_v2.runtime` for callers that prefer a
    factory over the ``client.authority_intelligence`` attribute.
    """
    return AuthorityIntelligenceClient(client)
