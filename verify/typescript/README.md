# `@atlasent/verify`

Offline verifier for AtlaSent's signed audit-export bundles.

This is the carved-out verifier package — auditors install only this,
not the full `@atlasent/sdk` (which carries HTTP clients, retries,
observability, and contract-drift tooling).

## Install

```bash
npm install @atlasent/verify @atlasent/sdk
```

`@atlasent/sdk` is a peer dependency for now while the source-of-truth
relocation lands; a future release will let you install
`@atlasent/verify` alone.

## Use

```ts
import { verifyBundle } from "@atlasent/verify";

const pem = await fetch(
  "https://atlasent.io/.well-known/atlasent-verifier-key.pem",
).then((r) => r.text());

const result = await verifyBundle("export.json", { publicKeysPem: [pem] });
if (!result.valid) throw new Error(`Bundle invalid: ${result.reason}`);
```

The verifier is byte-identical with the reference implementation in
`atlasent-api/supabase/functions/v1-audit/verify.ts`.

## Wire format

See [`atlasent-sdk/contract/schemas/audit-bundle.schema.json`][1].

[1]: https://github.com/AtlaSent-Systems-Inc/atlasent-sdk/blob/main/contract/schemas/audit-bundle.schema.json

## License

Apache-2.0.
