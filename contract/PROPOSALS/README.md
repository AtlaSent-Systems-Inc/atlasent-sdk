# Contract proposals

Concrete, reviewable design docs for changes to the AtlaSent wire
contract — new endpoints, wire formats, or out-of-band artifacts (like
the offline audit-bundle format) that aren't yet covered by
`contract/schemas/*.json` or `contract/openapi.yaml`.

Proposals live here while they still need cross-team decisions —
typically from the API team (wire format, status codes), the security
team (crypto / key management / canonicalization), or whoever owns an
external artifact (npm scopes, package publishing).

## Lifecycle

```
DRAFT ──► ACCEPTED ──► IMPLEMENTED
 │            │              │
 │            │              └─ Schema lives in contract/schemas/ (or the
 │            │                 OpenAPI paths list); SDKs ship the feature;
 │            │                 proposal is moved to contract/PROPOSALS/archive/
 │            │                 with a pointer to the final schema + PR.
 │            │
 │            └─ All open questions resolved. Schema / wire format is
 │               committed to contract/schemas/ (or the OpenAPI doc).
 │               SDK implementation can begin.
 │
 └─ Open questions flagged. Reviewable but not yet implementable.
    No SDK code lands against a DRAFT proposal.
```

`DRAFT` means: **do not invent the missing spec in SDK code.** The
proposal is a request for decisions, not a decided design. If a
proposal says "open question: Ed25519 signature encoding", the SDK
must not pick one and ship it — that would quietly make the SDK the
source of truth for a contract question that should be answered
collectively.

## What every proposal MUST have

1. **Status** — `DRAFT` / `ACCEPTED` / `IMPLEMENTED` at the top.
2. **Problem statement** — what SDK capability this enables and why
   the existing surface (`/v1-evaluate` + `/v1-verify-permit`) can't
   provide it.
3. **Proposed wire format / artifact shape** — concrete examples in
   the canonical encoding (JSON, YAML, HTTP trace, etc.). If crypto
   is involved, say exactly which curve / hash / signature encoding
   and what gets canonicalized how.
4. **Open questions** — the list of cross-team decisions that must
   be resolved before the proposal can advance to `ACCEPTED`.
   Whoever owns each decision is named (API team, security team,
   ops, etc.).
5. **SDK-side implementation sketch** — how the Python and TypeScript
   SDKs would expose the feature once the wire format is locked.
   Includes the public API signatures and which new types / errors
   get added to the error taxonomy.
6. **Test vector requirements** — what goes under
   `contract/vectors/` once the proposal lands, and how negative
   fixtures (tampered signatures, malformed streams, etc.) are
   shaped.

## Numbering

Proposals are numbered sequentially, zero-padded to three digits,
followed by a short kebab-case slug:

```
001-streaming-evaluate.md
002-audit-bundle.md
003-atlasent-types.md
```

A proposal keeps its number for life — if `001-streaming-evaluate.md`
is rejected in favour of a different shape, the replacement gets a
new number (`004-streaming-...`) and the old one is archived with
status `REJECTED`.

## Current proposals

| # | Title | Status | Needs decision from |
|---|---|---|---|
| [001](./001-streaming-evaluate.md) | Streaming `/v1-evaluate` | DRAFT | API team + streaming engineer |
| [002](./002-audit-bundle.md)       | Offline audit-bundle format | DRAFT | API team + security team |
| [003](./003-atlasent-types.md)     | `@atlasent/types` npm package | DRAFT | `@atlasent` npm scope owner |

## Adding a new proposal

1. Copy `000-template.md` (if present) or an existing proposal.
2. Bump the number to the next unused integer.
3. Fill in the six required sections above. Keep it under ~200 lines
   where possible — longer proposals should be split.
4. Open a PR titled `proposal(NNN): <title>`.
5. The proposal enters `DRAFT` status on merge. Moving it to
   `ACCEPTED` / `IMPLEMENTED` is a separate PR that also lands the
   schema / OpenAPI changes.
