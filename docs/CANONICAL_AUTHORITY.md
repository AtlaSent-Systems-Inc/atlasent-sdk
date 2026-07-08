# DenialResult — Canonical Authority

This document is the single source of truth for the `DenialResult` shape across
all SDK languages. When the two are in conflict, this document wins.

## Canonical form

The canonical `DenialResult` uses **snake_case field names** and a **boolean
`denied` discriminant**.

| Field | Type | Description |
|-------|------|-------------|
| `denied` | `bool` / `true` literal | Always `True`/`true`. Discriminates from a normal result. |
| `decision` | `str` / `string` | The raw decision string from the evaluator (`deny`, `hold`, `escalate`). |
| `evaluation_id` | `str` / `string` | The evaluation ID from the audit record. |
| `reason` | `str` / `string` | Human-readable denial reason. |
| `audit_hash` | `str \| None` / `string \| undefined` | Optional chain hash from the audit event. |

## Language conformance

### Python (conforms — snake_case, class-level discriminant)

```python
class DenialResult:
    """Returned instead of raising when ``on_deny='tool-result'``."""
    denied: bool = True  # class-level; always True

    def __init__(
        self,
        *,
        decision: str,
        evaluation_id: str,
        reason: str,
        audit_hash: str | None = None,
    ) -> None:
        self.decision = decision
        self.evaluation_id = evaluation_id
        self.reason = reason
        self.audit_hash = audit_hash
```

**Status: conforms.** Field names (`evaluation_id`, `audit_hash`) and the
`denied: bool = True` class-level discriminant match the canonical form exactly.

### TypeScript (deferred — camelCase by JS convention)

```typescript
export interface DenialResult {
  denied: true;          // literal true — correct discriminant
  decision: string;
  evaluationId: string;  // camelCase — diverges from canonical
  reason: string;
  auditHash?: string;    // camelCase — diverges from canonical
}
```

**Status: partial.** The `denied: true` literal discriminant is correct.
`evaluationId` and `auditHash` diverge from the snake_case canonical form.

**Why this was not fixed immediately:** renaming these fields is a breaking
change for every TypeScript caller that destructures `DenialResult`. The
rename (`evaluationId` → `evaluation_id`, `auditHash` → `audit_hash`) is
scheduled for the **T-02 major version bump**, where a clean breaking-change
window exists. Until then, TypeScript callers should use `evaluationId` and
`auditHash` and be aware that these differ from the canonical Python names.

## Implementation locations

### Python

The class is duplicated by design (each framework guard is a standalone
install). Both copies must be kept identical:

- `python/atlasent_langchain/atlasent_langchain/guard.py`
- `python/atlasent_llamaindex/atlasent_llamaindex/guard.py`

If a third Python framework guard is added, copy the class verbatim and
add it to the list above.

### TypeScript

The interface is duplicated across framework guards:

- `src/langchain/guard.ts`
- `src/llamaindex/guard.ts`
- `src/cursor/guard.ts`

The T-02 rename will be mechanical: a single sed pass + type-check confirms
all three copies are consistent.

## Guiding principles

1. **`denied` must always be present.** Its presence (and truthy value) is the
   only safe way for a caller to distinguish a `DenialResult` from a normal
   tool return value in dynamic-typed code paths.

2. **Snake_case is canonical.** New language ports must use snake_case. The
   TypeScript camelCase deviation is a grandfathered exception, not a model.

3. **No caching, no re-evaluation.** `DenialResult` is constructed once from
   the server response and returned directly. The SDK never re-evaluates or
   synthesizes a denial — the server is always the authority.
