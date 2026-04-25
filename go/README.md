# AtlaSent Go SDK

Execution-time authorization for AI agents and other non-human actors,
called over HTTP from Go.

## Install

```sh
go get github.com/AtlaSent-Systems-Inc/atlasent-sdk/go
```

Requires Go 1.22+.

## Usage

```go
package main

import (
    "context"
    "errors"
    "fmt"
    "log"
    "os"

    atlasent "github.com/AtlaSent-Systems-Inc/atlasent-sdk/go"
)

func main() {
    client := atlasent.NewClient(
        "https://api.atlasent.io",
        os.Getenv("ATLASENT_API_KEY"),
    )

    decision, err := client.Evaluate(context.Background(), atlasent.EvaluationRequest{
        Actor:   atlasent.EvaluationActor{ID: "agent.deploy-bot", Type: "agent", OrgID: "org_123"},
        Action:  atlasent.EvaluationAction{ID: "deploy_to_production"},
        Context: map[string]any{"commit": "abc123", "approver": "alice"},
    })
    if err != nil {
        // Fail-closed: never proceed on error. Branch with errors.Is for finer
        // policy on the operational dashboards.
        switch {
        case errors.Is(err, atlasent.ErrUnauthorized):
            log.Fatalf("revoke or rotate the API key: %v", err)
        case errors.Is(err, atlasent.ErrRateLimited):
            log.Fatalf("back off and retry later: %v", err)
        default:
            log.Fatalf("atlasent unavailable: %v", err)
        }
    }
    if decision.Decision != atlasent.DecisionAllow {
        log.Fatalf("denied: %s — %s", decision.DenyCode, decision.DenyReason)
    }
    fmt.Printf("permit issued: %s (expires %s)\n",
        decision.Permit.ID, decision.Permit.ExpiresAt)
}
```

## Error model

`Evaluate` returns one of three error families:

1. **Context errors** (`context.Canceled`, `context.DeadlineExceeded`)
   surface as-is so `errors.Is` works against the standard library.
2. **Transport errors** (DNS, dial, read failures) return a
   `*TransportError` wrapping the cause; matches
   `errors.Is(err, ErrTransport)`.
3. **HTTP errors** return `*HTTPError` carrying `Status`, `Body`,
   `RetryAfter` (for 429), and one of the sentinels:
   `ErrUnauthorized`, `ErrForbidden`, `ErrRateLimited`,
   `ErrServer`, `ErrBadRequest`.

This mirrors the discipline of the GitHub Action wrapper
(`atlasent-action/src/index.ts`): transport errors block, never allow.

## Status

`v1.0.0` is **not yet tagged**. To publish:

```sh
git tag go/v1.0.0
git push origin go/v1.0.0
```

Go modules resolve from git tags — no separate publish workflow is
required. The `/go` subdirectory layout is what `go get` expects when
the module path is `…/atlasent-sdk/go` (the slash before `v` in the
tag is required by Go's subdirectory-module convention).

## License

Apache-2.0 (matches the rest of `atlasent-sdk`).
