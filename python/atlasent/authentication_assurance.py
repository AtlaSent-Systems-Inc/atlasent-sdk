"""authentication_assurance — CROSS-016 / proposal 0003 evidence/requirement types.

Python mirror of the TypeScript ``authenticationAssurance.ts`` module, which
itself mirrors the wire-contract authority
``atlasent/packages/types/src/authentication-assurance-v1.ts`` (CROSS-016:
atlasent-docs architecture/adr/CROSS-016-assurance-aware-authorization.md,
landed via atlasent's
contract/proposals/0003-authentication-assurance-evidence-and-requirement.md).
Matches ``atlasent/contract/schemas/authentication-assurance.v1.schema.json``.

ADDITIVE, NOT YET ENFORCED: the companion resolver (atlasent-api's
``supabase/functions/_shared/assurance_resolver.ts``) is deliberately
shadow-first and is not wired into ``/v1-evaluate`` yet (CROSS-016 §10) — no
wire endpoint carries these shapes today, so this module is intentionally
absent from ``contract/tools/drift.py`` (which only tracks the live
``/v1-evaluate`` / ``/v1-verify-permit`` / v2 request-response bodies). Same
reasoning applies to ``context_envelope.py``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Literal, TypedDict, Union

# Full RFC 3339 date-time: date + time(seconds) + optional fraction + `Z` or
# `±HH:MM`. Deliberately regex-only (no calendar-impossibility check) to stay
# byte-for-byte aligned with the canonical TypeScript validator this module
# mirrors — a fourth divergent acceptance criterion across repos is exactly
# the drift this contract exists to prevent.
_ISO_8601_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$"
)


def _is_iso8601(value: Any) -> bool:
    return isinstance(value, str) and bool(_ISO_8601_RE.match(value))


def _scalar_kind(x: Any) -> str | None:
    """Mirrors JavaScript `typeof` for the three scalar kinds this contract
    cares about — boolean / number / string — so a bool is never conflated
    with a number (Python's `bool` is an `int` subclass; check it first).
    Returns None for anything non-scalar (dict, list, None, etc.).
    """
    if isinstance(x, bool):
        return "boolean"
    if isinstance(x, (int, float)):
        return "number"
    if isinstance(x, str):
        return "string"
    return None


# ── Leaf shapes ──────────────────────────────────────────────────────────


@dataclass(frozen=True)
class MethodProvenance:
    method: str
    issuer: str
    verified: bool


@dataclass(frozen=True)
class AuthenticationAssuranceEvidence:
    """What was proved at authentication time. Never a requirement."""

    methods: tuple[MethodProvenance, ...]
    factor_count: int
    phishing_resistant: bool
    auth_time: str
    """RFC 3339 date-time."""

    issuer: str
    """Absolute URI identifying the issuer."""

    verification_status: Literal["verified", "unverified", "unknown"]
    capability_summary: tuple[str, ...]


@dataclass(frozen=True)
class PredicateRegistryEntry:
    """CROSS-016 §4's registry contract for a single predicate."""

    id: str
    semantics: str
    value_type: Literal["scalar", "boolean", "set"]
    evaluation: Literal["min", "max", "intersection", "exact"]
    version: int
    unknown_handling: Literal["hold"] = "hold"
    """Always 'hold' — CROSS-016 §7 makes this non-negotiable per-predicate."""


class PredicateInstance(TypedDict):
    predicate_id: str
    value: Any


class ResourceContextCondition(TypedDict):
    """v1 closed condition vocabulary for resource/context matching.

    (proposal 0003 §1). ``field`` is a registered CDO context-field
    identifier, never an arbitrary JSON path. ``eq`` requires a scalar
    value; ``in`` requires a homogeneous non-empty scalar array. An
    unknown field, a type mismatch, or unavailable context must resolve
    to ``hold`` at evaluation time, never to "condition false" — same
    fail-closed posture as every other undecided case in this contract.
    Conditions within one requirement are conjunctive.
    """

    field: str
    operator: Literal["eq", "in"]
    value: Any


AssuranceRequirementLayer = Literal[
    "external_obligation", "organization", "action_class", "resource_context"
]
"""CROSS-016 §5's four-layer default, deliberately distinct from PolicyLayer."""


# ── AuthenticationAssuranceRequirement — a discriminated union on `layer` ──
#
# `source_type` is required for `external_obligation` (distinguishing the two
# DB sources, proposal 0003 §2) and structurally absent otherwise. `when`
# conditions are optional for `action_class` and required (at least one) for
# an independently authored `resource_context` source. Python's TypedDict has
# no native discriminated-union enforcement (that's what
# validate_authentication_assurance_requirement() is for), so this mirrors
# the shape via a union of four per-layer TypedDicts, each split into a
# required base plus an optional-fields subclass — same pattern as
# claim_lineage.py's TypedDict inputs.


class _ExternalObligationRequirementRequired(TypedDict):
    layer: Literal["external_obligation"]
    source_type: Literal["regime_profile", "contractual_constraint"]
    source_id: str
    predicates: list[PredicateInstance]
    effective_from: str


class ExternalObligationRequirement(
    _ExternalObligationRequirementRequired, total=False
):
    effective_until: str | None


class _OrganizationRequirementRequired(TypedDict):
    layer: Literal["organization"]
    source_id: str
    predicates: list[PredicateInstance]
    effective_from: str


class OrganizationRequirement(_OrganizationRequirementRequired, total=False):
    effective_until: str | None


class _ActionClassRequirementRequired(TypedDict):
    layer: Literal["action_class"]
    source_id: str
    predicates: list[PredicateInstance]
    effective_from: str


class ActionClassRequirement(_ActionClassRequirementRequired, total=False):
    when: list[ResourceContextCondition]
    effective_until: str | None


class _ResourceContextRequirementRequired(TypedDict):
    layer: Literal["resource_context"]
    source_id: str
    predicates: list[PredicateInstance]
    when: list[ResourceContextCondition]
    effective_from: str


class ResourceContextRequirement(_ResourceContextRequirementRequired, total=False):
    effective_until: str | None


AuthenticationAssuranceRequirement = Union[  # noqa: UP007 — py3.9 compat, see docstring below
    ExternalObligationRequirement,
    OrganizationRequirement,
    ActionClassRequirement,
    ResourceContextRequirement,
]
"""What one source demands. See the four per-layer TypedDicts above.

Uses typing.Union rather than the `X | Y` runtime syntax: this is a plain
module-level assignment (not a type annotation), so `from __future__ import
annotations` does not defer its evaluation — on Python 3.9 (still this
package's floor per pyproject.toml), `SomeTypedDict | OtherTypedDict`
raises TypeError at import time because `type.__or__` for arbitrary classes
was only added in 3.10.
"""


@dataclass(frozen=True)
class EffectiveAssurancePredicateEntry:
    value: Any
    contributing_sources: tuple[str, ...]
    """Full-provenance requirement — never collapse to one "winner"."""

    decisive_sources: tuple[str, ...]


@dataclass(frozen=True)
class EffectiveAuthenticationAssuranceRequirement:
    """CROSS-016 §6's conjunction over every applicable requirement."""

    predicates: dict[str, EffectiveAssurancePredicateEntry] = field(
        default_factory=dict
    )


AuthenticationAssuranceOutcomeCode = Literal[
    "ASSURANCE_APPLICABILITY_UNDETERMINED",
    "ASSURANCE_EVIDENCE_MISSING",
    "ASSURANCE_ISSUER_UNTRUSTED",
    "ASSURANCE_EVIDENCE_UNVERIFIED",
    "ASSURANCE_EVIDENCE_SOURCE_CONFLICT",
    "ASSURANCE_EVIDENCE_STALE",
    "ASSURANCE_POLICY_CONFLICT",
    "ASSURANCE_RESOLUTION_INDETERMINATE",
    "ASSURANCE_REQUIREMENT_UNMET",
]
"""Closed code vocabulary for non-allow assurance outcomes (proposal 0003 §4)."""

_OUTCOME_CODES: frozenset[str] = frozenset(
    (
        "ASSURANCE_APPLICABILITY_UNDETERMINED",
        "ASSURANCE_EVIDENCE_MISSING",
        "ASSURANCE_ISSUER_UNTRUSTED",
        "ASSURANCE_EVIDENCE_UNVERIFIED",
        "ASSURANCE_EVIDENCE_SOURCE_CONFLICT",
        "ASSURANCE_EVIDENCE_STALE",
        "ASSURANCE_POLICY_CONFLICT",
        "ASSURANCE_RESOLUTION_INDETERMINATE",
        "ASSURANCE_REQUIREMENT_UNMET",
    )
)


def is_authentication_assurance_outcome_code(code: Any) -> bool:
    """True when `code` is one of the nine registered ASSURANCE_* codes."""
    return isinstance(code, str) and code in _OUTCOME_CODES


AssuranceResolutionStatus = Literal["resolved", "indeterminate", "conflict"]
"""The umbrella resolution state persisted onto
``regulated_constraint_bundles.assurance_resolution_status`` (proposal 0003
§3, atlasent-api). ``indeterminate`` is what CROSS-016's Critical Invariant
requires on any resolver-internal failure — it must never be silently
``resolved``.
"""


@dataclass(frozen=True)
class AssuranceResolutionReason:
    """A typed reason backing a hold/deny or indeterminate/conflict status."""

    code: AuthenticationAssuranceOutcomeCode
    detail: str
    predicate_id: str | None = None


class _AssuranceEvaluationOutcomeAllowRequired(TypedDict):
    result: Literal["allow"]
    trace_ref: str


class AssuranceEvaluationOutcomeAllow(
    _AssuranceEvaluationOutcomeAllowRequired, total=False
):
    requirement_ref: str
    evidence_ref: str


class _AssuranceEvaluationOutcomeNonAllowRequired(TypedDict):
    result: Literal["hold", "deny"]
    code: AuthenticationAssuranceOutcomeCode
    trace_ref: str


class AssuranceEvaluationOutcomeNonAllow(
    _AssuranceEvaluationOutcomeNonAllowRequired, total=False
):
    requirement_ref: str
    evidence_ref: str


AssuranceEvaluationOutcome = Union[  # noqa: UP007 — py3.9 compat, same reason as above
    AssuranceEvaluationOutcomeAllow, AssuranceEvaluationOutcomeNonAllow
]
"""CROSS-016 §7. Every outcome references its per-evaluation assurance trace.
Every non-allow outcome requires a typed code. ``requirement_ref`` is present
when resolution produced an effective requirement, but is correctly absent
for applicability/resolver failures that occur before one exists.
"""


# ── Structural validators ───────────────────────────────────────────────
#
# Operate on plain dicts (the wire/persisted form) rather than the dataclasses
# above, mirroring the TypeScript validators this module ports — and matching
# this SDK's existing convention (context_envelope.py's
# validate_resource_classification_assertion operates on ``value: Any``, not
# a constructed dataclass).


def _is_method_provenance_shape(x: Any) -> bool:
    return (
        isinstance(x, dict)
        and isinstance(x.get("method"), str)
        and x.get("method") != ""
        and isinstance(x.get("issuer"), str)
        and x.get("issuer") != ""
        and isinstance(x.get("verified"), bool)
    )


def _is_predicate_instance_shape(x: Any) -> bool:
    return (
        isinstance(x, dict)
        and isinstance(x.get("predicate_id"), str)
        and x.get("predicate_id") != ""
        and "value" in x
    )


def _is_resource_context_condition_shape(x: Any) -> bool:
    if not isinstance(x, dict):
        return False
    field_name = x.get("field")
    if not isinstance(field_name, str) or field_name == "":
        return False
    operator = x.get("operator")
    if operator not in ("eq", "in"):
        return False
    value = x.get("value")
    if operator == "eq":
        return _scalar_kind(value) is not None
    # operator == "in": a non-empty, homogeneous list of scalars.
    if not isinstance(value, list) or len(value) == 0:
        return False
    element_kind = _scalar_kind(value[0])
    if element_kind is None:
        return False
    return all(_scalar_kind(v) == element_kind for v in value)


def validate_authentication_assurance_evidence(value: Any) -> list[str]:
    """Validate an AuthenticationAssuranceEvidence dict. [] = well-formed."""
    if not isinstance(value, dict):
        return ["input must be a dict"]
    problems: list[str] = []
    methods = value.get("methods")
    if not isinstance(methods, list):
        problems.append("methods must be an array")
    elif not all(_is_method_provenance_shape(m) for m in methods):
        problems.append(
            "methods must contain only well-formed { method, issuer, verified } entries"
        )
    factor_count = value.get("factor_count")
    if (
        isinstance(factor_count, bool)
        or not isinstance(factor_count, int)
        or factor_count < 0
    ):
        problems.append("factor_count must be a non-negative integer")
    if not isinstance(value.get("phishing_resistant"), bool):
        problems.append("phishing_resistant must be a boolean")
    if not _is_iso8601(value.get("auth_time")):
        problems.append("auth_time must be an RFC 3339 date-time")
    issuer = value.get("issuer")
    if not isinstance(issuer, str) or not issuer:
        problems.append("issuer must be a non-empty string (absolute URI)")
    if value.get("verification_status") not in ("verified", "unverified", "unknown"):
        problems.append(
            "verification_status must be 'verified' | 'unverified' | 'unknown'"
        )
    capability_summary = value.get("capability_summary")
    if not isinstance(capability_summary, list):
        problems.append("capability_summary must be an array")
    elif not all(isinstance(c, str) for c in capability_summary):
        problems.append("capability_summary must contain only strings")
    return problems


def validate_authentication_assurance_requirement(value: Any) -> list[str]:
    """Validate one AuthenticationAssuranceRequirement dict. [] = well-formed."""
    if not isinstance(value, dict):
        return ["input must be a dict"]
    layer = value.get("layer")
    valid_layers = (
        "external_obligation",
        "organization",
        "action_class",
        "resource_context",
    )
    if layer not in valid_layers:
        return [f"layer must be one of {' | '.join(valid_layers)}"]
    problems: list[str] = []
    if layer == "external_obligation":
        if value.get("source_type") not in ("regime_profile", "contractual_constraint"):
            problems.append(
                "source_type is required and must be 'regime_profile' | "
                "'contractual_constraint' when layer is external_obligation"
            )
    elif "source_type" in value:
        problems.append(f"source_type must be absent when layer is {layer}")
    source_id = value.get("source_id")
    if not isinstance(source_id, str) or not source_id:
        problems.append("source_id must be a non-empty string")
    predicates = value.get("predicates")
    if not isinstance(predicates, list):
        problems.append("predicates must be an array")
    elif not all(_is_predicate_instance_shape(p) for p in predicates):
        problems.append(
            "predicates must contain only well-formed { predicate_id, value } entries"
        )
    when = value.get("when")
    if layer == "resource_context":
        if not isinstance(when, list) or len(when) == 0:
            problems.append(
                "when must be a non-empty array when layer is resource_context"
            )
        elif not all(_is_resource_context_condition_shape(c) for c in when):
            problems.append(
                "when must contain only well-formed "
                "{ field, operator, value } conditions"
            )
    elif "when" in value:
        if not isinstance(when, list):
            problems.append("when, when present, must be an array")
        elif not all(_is_resource_context_condition_shape(c) for c in when):
            problems.append(
                "when must contain only well-formed "
                "{ field, operator, value } conditions"
            )
    if not _is_iso8601(value.get("effective_from")):
        problems.append("effective_from must be an RFC 3339 date-time")
    effective_until = value.get("effective_until")
    if (
        "effective_until" in value
        and effective_until is not None
        and not _is_iso8601(effective_until)
    ):
        problems.append(
            "effective_until, when present, must be null or an RFC 3339 date-time"
        )
    return problems


def is_authentication_assurance_requirement(value: Any) -> bool:
    """True when `value` is a well-formed AuthenticationAssuranceRequirement."""
    return validate_authentication_assurance_requirement(value) == []


ResourceContextConditionMatch = Literal["match", "no_match", "undetermined"]


def matches_resource_context_condition(
    condition: ResourceContextCondition, context: dict[str, Any]
) -> ResourceContextConditionMatch:
    """Evaluate a single ResourceContextCondition against a flat context dict.

    ``undetermined`` — never ``no_match`` — for: a missing context key; an
    ``in`` condition whose declared value isn't actually a list (or is
    empty, so no element kind can be determined); a context value that
    isn't itself a scalar; or a scalar-kind mismatch between the context
    value and the condition's declared value(s) (e.g. comparing a number
    against a declared string). A caller MUST treat ``undetermined`` as
    ``hold`` (CROSS-016 §7); collapsing it into a plain boolean ``False``
    reads as "this condition doesn't apply" and can silently drop a
    requirement from composition instead of holding on it — that includes
    a type mismatch, which is exactly as undecidable as a missing field.
    """
    field_name = condition["field"]
    if field_name not in context:
        return "undetermined"
    actual = context[field_name]
    actual_kind = _scalar_kind(actual)
    if condition["operator"] == "eq":
        if actual_kind is None or actual_kind != _scalar_kind(condition["value"]):
            return "undetermined"
        return "match" if actual == condition["value"] else "no_match"
    # operator == "in"
    candidate_values = condition["value"]
    if not isinstance(candidate_values, list) or len(candidate_values) == 0:
        return "undetermined"
    element_kind = _scalar_kind(candidate_values[0])
    if actual_kind is None or actual_kind != element_kind:
        return "undetermined"
    return "match" if actual in candidate_values else "no_match"


__all__ = [
    "ActionClassRequirement",
    "AssuranceEvaluationOutcome",
    "AssuranceEvaluationOutcomeAllow",
    "AssuranceEvaluationOutcomeNonAllow",
    "AssuranceRequirementLayer",
    "AssuranceResolutionReason",
    "AssuranceResolutionStatus",
    "AuthenticationAssuranceEvidence",
    "AuthenticationAssuranceOutcomeCode",
    "AuthenticationAssuranceRequirement",
    "EffectiveAssurancePredicateEntry",
    "EffectiveAuthenticationAssuranceRequirement",
    "ExternalObligationRequirement",
    "MethodProvenance",
    "OrganizationRequirement",
    "PredicateInstance",
    "PredicateRegistryEntry",
    "ResourceContextCondition",
    "ResourceContextConditionMatch",
    "ResourceContextRequirement",
    "is_authentication_assurance_outcome_code",
    "is_authentication_assurance_requirement",
    "matches_resource_context_condition",
    "validate_authentication_assurance_evidence",
    "validate_authentication_assurance_requirement",
]
