# @atlasent/sdk-ts

Minimal TypeScript SDK for AtlaSent authorization.

> For the full-featured TypeScript monorepo SDK, see `atlasent-systems-inc/atlasent`.

## Install

```bash
npm install @atlasent/sdk-ts
# or
pnpm add @atlasent/sdk-ts
```

## Quick start

```typescript
import { AtlaSentClient, AtlaSentDeniedError } from "@atlasent/sdk-ts";

const client = new AtlaSentClient({ apiKey: process.env.ATLASENT_API_KEY! });

try {
  const result = await client.authorizeOrThrow({
    agentId: "my-agent",
    actionType: "production.deploy",
    context: { environment: "production", approvals: 2 },
  });
  console.log("Allowed", result.permitToken);
} catch (err) {
  if (err instanceof AtlaSentDeniedError) {
    console.error("Denied:", err.code);
  }
}
```

## API

### `AtlaSentClient`

- `evaluate(req)` → `EvaluateResponse`
- `authorizeOrThrow(req)` → `EvaluateResponse` (throws on deny/hold/escalate)
- `verifyPermit(req)` → `VerifyPermitResponse`

### Errors

- `AtlaSentDeniedError` — decision is `deny`
- `AtlaSentHoldError` — decision is `hold`
- `AtlaSentEscalateError` — decision is `escalate`
- `AtlaSentAPIError` — non-2xx HTTP response

## License

MIT
