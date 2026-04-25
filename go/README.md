# AtlaSent Go SDK

Execution-time authorization for AI agents — Go edition.

## Status

**Scaffold.** This module establishes the import path and minimal
surface so downstream consumers can pin a version while the
implementation lands.

Method signatures mirror the TypeScript and Python SDKs for
cross-language parity (see [`SDK_COMPATIBILITY.md`][1]). Calls return
`atlasent.ErrNotImplemented` until the HTTP transport ships.

[1]: ../contract/SDK_COMPATIBILITY.md

## Install (when implemented)

```bash
go get github.com/AtlaSent-Systems-Inc/atlasent-sdk/go
```

## Use (intended shape)

```go
package main

import (
    "context"
    "log"
    "os"

    "github.com/AtlaSent-Systems-Inc/atlasent-sdk/go"
)

func main() {
    client := atlasent.NewClient(atlasent.ClientOptions{
        APIKey:  os.Getenv("ATLASENT_API_KEY"),
        BaseURL: "https://api.atlasent.io",
    })

    permit, err := client.Protect(context.Background(), atlasent.ProtectRequest{
        Agent:  "deploy-bot",
        Action: "deploy_to_production",
        Context: map[string]interface{}{
            "commit":   "deadbeef",
            "approver": "alice@acme.com",
        },
    })
    if err != nil {
        log.Fatalf("authorization failed: %v", err)
    }
    log.Printf("permit %s issued", permit.PermitID)
}
```

## Wire format

The Go SDK speaks the same JSON over HTTP as every other AtlaSent
SDK — `POST /v1-evaluate` and `POST /v1-verify-permit`. See
[`contract/openapi.yaml`][2] in this repo.

[2]: ../contract/openapi.yaml

## Decision literal

Unlike `@atlasent/sdk` and `atlasent`, the Go SDK exposes the full
four-valued backend decision (`allow`, `deny`, `hold`, `escalate`)
on the public surface. The TS and Python SDKs collapse to
`ALLOW | DENY` for historical reasons; Go is greenfield so we ship
the canonical literal from day one.

## License

Apache-2.0.
