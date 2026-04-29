from __future__ import annotations


class DisallowedConfigError(Exception):
    """Raised when an Enforce config violates a non-toggleable invariant.

    Per ``contract/ENFORCE_PACK.md`` invariant 2, ``fail_closed`` is
    locked to ``True``; any attempt to construct an Enforce instance
    with ``fail_closed=False`` raises this error at construction time.
    """
