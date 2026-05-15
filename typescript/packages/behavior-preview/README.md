# `@atlasent/behavior-preview` — PREVIEW, DO NOT USE IN PRODUCTION

> **Status:** scaffold. Every function in this package throws `NotImplementedError` until `behavior-insights` ships:
> - **BI2** — `pattern_entries` read API
> - **BI3** — sensitive-category aggregates
> - **BI4** — frozen `BvsSnapshot` wire shape
> - **BI5** — consent-class projection
>
> Tracked in `behavior-insights/V2_ROLLOUT.md`. Closing `behavior-insights#9` is the hard prerequisite.

Companion preview package for the v2 **Behavior Conditioning Layer**. Stubs only — exists so downstream packages (`atlasent-mcp-server` C.MCP1, `langchain-llamaindex-integration` C.LL6, `atlasent-action` future behavior-aware gate, `gxp-starter` HIPAA category extension, `atlasent-examples` flow 07) can import against a stable surface while the real implementation lands.

## Why a preview package?

1. Five Wave-B/C v2 plans reference `@atlasent/behavior` as a pending dependency. Without a scaffold, every downstream consumer codes against vaporware.
2. The real implementation depends on `behavior-insights` shipping BI2–BI5, which is gated on issue #9 + staging smoke. That work is independent of consumer integration.
3. Pre-GA breakage is expected: the function signatures here are the v2-D5-shaped contract, but the wire shape (`BvsSnapshot`) is not frozen until BI4. Pin to an exact version if you import this from real code.

## Surface

```ts
import {
  getStateSummary,
  getCategoryAggregate,
  attachToEvaluate,
} from "@atlasent/behavior-preview";

import type {
  StateSummary,
  BvsSnapshot,
  BehaviorCategory,
  CategoryAggregate,
} from "@atlasent/behavior-preview";
```

| Export | Purpose | Status |
|---|---|---|
| `getStateSummary(userId, opts?)` | Redacted `StateEvent` summary (last N); aggregates-only, never raw text | stub |
| `getCategoryAggregate(userId, category, opts?)` | Per-category counts (`behavior.health.mental`, `…adherence`, `behavior.financial`, `behavior.minor`) | stub |
| `attachToEvaluate(request, userId)` | Convenience: stamps `context.user_state` + `context.bvsSnapshot` onto an `EvaluateRequest` | stub |
| Types: `StateSummary`, `BvsSnapshot`, `BehaviorCategory`, `CategoryAggregate` | 1:1 with the v2-D5 surface; subject to change until BI4 | preview |

## Privacy contract

This package never returns raw event text — only aggregate projections. The wire contract:

- `StateSummary` carries counts, deltas, time-window summaries — no `text`, no `note`.
- `BvsSnapshot` carries factor-model output + decay confidence — no event-level data.
- `CategoryAggregate` is per-category counts only.

The same redacted projection that crosses the LedgersMe boundary. Enforced server-side by `behavior-insights`; this package's job is to surface those aggregates without leaking.

## NotImplementedError stubs

Every function currently throws:

```ts
throw new NotImplementedError(
  "@atlasent/behavior-preview is a scaffold. " +
  "Implementation lands when behavior-insights ships BI2-BI5. " +
  "See behavior-insights/V2_ROLLOUT.md and issue #9."
);
```

Consumers can import the types and wire up code paths today; the stubs throw at runtime if invoked. CI in downstream repos can gate on `v2_behavior_conditioning=false` to keep the throw path dead.

## Cross-repo links

- `behavior-insights/V2_ROLLOUT.md` — supplier slice (BI1–BI8)
- `atlasent-sdk/V2_ROLLOUT.md` — B.SDK9 calls this package out as the dangling dependency
- `atlasent/V2_BEHAVIOR_CONDITIONING_LAYER.md` (in `atlasent-docs`) — full layer spec
- `atlasent/V2_DECISIONS.md` — V2-D5 (TS SDK packaging) shapes which package this consolidates into at v2 GA

## v2 GA path

At v2 GA, this package either:

1. Promotes to `@atlasent/behavior` (drops `-preview`, becomes the canonical name), or
2. Consolidates into `@atlasent/sdk@2.x` as a sub-export (`@atlasent/sdk/behavior`), pending V2-D5.

Either path is a single rename + re-export shim; nothing breaks for consumers who pinned to `-preview` because the `-preview` package can stay published indefinitely as a no-op alias.
