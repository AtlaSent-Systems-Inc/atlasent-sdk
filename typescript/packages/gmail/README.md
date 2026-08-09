# `@atlasent/gmail`

AtlaSent send-time authorization gate for the Gmail API. Implements
CANON-000047 / ACT-0050 (`communication.external.send`) as a **send-time
API gate**: AtlaSent evaluates and cryptographically verifies the send
*before* the caller's own Gmail API call is ever made. A denied, held,
or unverified request never reaches Gmail.

```
1. evaluate     — check the policy engine (communication.external.send)
2. verifyPermit — confirm the permit cryptographically
3. send         — call gmail.users.messages.send ONLY if both pass
```

Zero runtime dependency on `googleapis` — it is a type-only import, so
this package works with whatever `googleapis` version you already have
installed and adds no runtime weight of its own. `@atlasent/sdk` is a
peer dependency, same as `@atlasent/cursor` and `@atlasent/langchain`.

## Install

```bash
npm install @atlasent/gmail @atlasent/sdk googleapis
```

## Usage

```ts
import { google } from "googleapis";
import { AtlaSentClient } from "@atlasent/sdk";
import { guardedGmailSend } from "@atlasent/gmail";

const gmail = google.gmail({ version: "v1", auth: oauth2Client });
const atlasent = new AtlaSentClient({ apiKey, baseUrl });

const result = await guardedGmailSend(
  gmail,
  atlasent,
  { userId: "me", requestBody: { raw: encodedMimeMessage } },
  {
    recipient: "newcustomer@example.com",
    recipientKnown: false,
    sensitiveAttachment: true,
    attachmentSha256: "3b1c...deadbeef", // content hash of the attachment/body
    approvals: 1, // count of verified human approvals already recorded
  },
  { agent: "user:sales-rep-01" },
);

if (result.sent) {
  console.log("sent", result.message.id, "permit", result.permitId);
} else {
  console.log("blocked", result.decision, result.reason);
}
```

`guardedGmailSendDraft` wraps `gmail.users.drafts.send` (sending an
already-composed draft) the same way. `gmail.users.drafts.create` /
`gmail.users.messages.insert` are deliberately **not** wrapped — neither
delivers mail, so neither is a `communication.external.send` event.

## Exact recipient/content binding

The four facts you supply — `recipient`, `attachmentSha256`,
`sensitiveAttachment`, and (derived) `recipientDomain` — are folded into
a SHA-256 hash (`computeExternalSendTargetId`) presented as
`context.target.id` at both evaluate and verify time. If any of those
facts change between evaluate and verify — e.g. a caller re-presents the
same permit token against a swapped recipient after a human approved a
different, lower-risk send — the hash no longer matches what the
runtime bound to the permit, and `v1-verify-permit`'s generic
exact-binding mechanism refuses with `PERMIT_BINDING_MISMATCH`. This
package invents no new binding primitive; it is a thin client of the
mechanism already proven in `atlasent-api`'s
`v1-verify-permit/handler.test.ts` "communication.external.send exact
binding" suite (recipient mutation, attachment mutation, sensitivity-flag
mutation, and replay of an already-consumed permit are all refused).

## Fail-closed guarantees

- **Deny / hold / escalate** → the real Gmail API call is never made.
- **Evaluate or verify network error** → the real Gmail API call is
  never made (`decision: "error"`).
- **Verify returns `verified: false`** (mismatch, expired, revoked,
  replayed, malformed) → the real Gmail API call is never made
  (`decision: "verify_failed"`).
- The real Gmail API call happens in exactly one place in this
  package's source (`runGuardedSend`'s final `performSend()` call),
  reached only after both `evaluate` returned `allow` and `verifyPermit`
  returned `verified: true`.

## Options

| Option | Type | Description |
| --- | --- | --- |
| `agent` | `string` | Required. AtlaSent actor identifier for the caller (e.g. `"user:sales-rep-01"`, `"agent:outreach-assistant"`). |
| `environment` | `string` | Optional. Defaults to `"production"`. |
| `extraContext` | `object` | Optional. Extra context merged into the evaluate call. |
| `onDeny` | `"result"` (default) \| `"throw"` | `"result"` returns a `GmailSendDenial`; `"throw"` raises `GmailSendDeniedError`. |

## What this package does NOT decide

- **How you obtain the four exact-binding facts** (recipient, attachment
  hash, sensitivity flag, recipient-known status) is entirely up to your
  integration. This package does not parse a raw Gmail MIME payload to
  derive them — see
  `atlasent/contract/safeguard-pack/connector-readiness/gmail.readiness.yaml`
  for why that customization choice is deliberately left open rather
  than guessed at here.
- **OAuth client setup and scopes.** You are responsible for
  authenticating the `gmail_v1.Gmail` client you pass in (this package
  never touches Google credentials). The `gmail.send` scope
  (`https://www.googleapis.com/auth/gmail.send`) is the well-documented
  minimum for `users.messages.send`; anything about a specific Google
  Workspace admin configuration is outside this package's scope and is
  not guessed at.

## Testing

This package has never been exercised against a live Gmail/Workspace
account — there is no fixture for that in this repository, and none is
fabricated. All tests use a mocked `gmail_v1.Gmail`-shaped object and a
mocked `AtlaSentClient`; see `test/guard.test.ts`, in particular the
"NEVER calls the real Gmail send on a deny decision" test, which is the
single most load-bearing assertion in this package.
