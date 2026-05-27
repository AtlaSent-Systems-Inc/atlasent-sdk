# AtlaSent Go SDK v2

[![pkg.go.dev](https://pkg.go.dev/badge/github.com/atlasent-systems-inc/atlasent-sdk/go/v2.svg)](https://pkg.go.dev/github.com/atlasent-systems-inc/atlasent-sdk/go/v2)

The official AtlaSent Go SDK — execution-time authorization for AI agents.

## Installation

```bash
go get github.com/atlasent-systems-inc/atlasent-sdk/go/v2@latest
```

## Quick start

```go
import atlasent "github.com/atlasent-systems-inc/atlasent-sdk/go/v2"

client := atlasent.New(atlasent.Options{
    APIKey: os.Getenv("ATLASENT_API_KEY"),
})

// Fail-closed authorization
permit, err := client.Protect(ctx, atlasent.ProtectRequest{
    Agent:  "deploy-bot",
    Action: "production.deploy",
    Context: map[string]any{
        "environment": "production",
        "commit":      commitSHA,
    },
})
if err != nil {
    // fail-closed: action must not proceed
    return err
}
```

## Evidence bundles

```go
bundle, err := client.EvidenceBundles.Create(ctx, atlasent.EvidenceBundleCreateRequest{
    IncidentID:       "inc_abc123",
    IncludeOverrides: true,
})

// Retrieve later
bundle, err = client.EvidenceBundles.Get(ctx, "bnd_xyz")

// Download as PDF
pdf, err := client.EvidenceBundles.Download(ctx, "bnd_xyz", "pdf")
```

## SCIM provisioning

```go
// List users
users, err := client.SCIM.Users.List(ctx, atlasent.SCIMListParams{
    OrgID: "org_abc",
})

// Create a user
newUser, err := client.SCIM.Users.Create(ctx, "org_abc", atlasent.SCIMUser{
    UserName:    "alice@example.com",
    DisplayName: "Alice Example",
    Active:      true,
    Emails: []atlasent.SCIMEmail{
        {Value: "alice@example.com", Primary: true},
    },
})

// Delete a user
err = client.SCIM.Users.Delete(ctx, "org_abc", "usr_123")
```

## Multi-IdP token refresh

```go
// List available IdP connections
connections, err := client.Auth.ListIdPConnections(ctx)

// Refresh using a specific IdP
tokens, err := client.Auth.RefreshWithIdP(ctx, "idp_okta_prod", currentRefreshToken)

// Refresh using the default IdP
tokens, err = client.Auth.Refresh(ctx, currentRefreshToken)
```

## Module path & versioning

This is a v2 module following the [Go module major version suffix convention](https://go.dev/ref/mod#major-version-suffixes).
The v1 runtime contracts froze on 2026-05-17 (V2-D9); this SDK is now published
at the stable v2 module path.

## Releasing

See [RELEASING.md](../RELEASING.md). The Go module is published by tagging:

```bash
git tag go/v2.0.0
git push origin go/v2.0.0
```

The `.github/workflows/publish-go.yml` workflow runs tests, prods the module
proxy to trigger `pkg.go.dev` indexing, and uploads a cosign Sigstore signature
bundle to the GitHub release.
