# AtlaSent Pilot Quickstart

Zero-to-first-evaluation in under 2 minutes.

## Prerequisites

- Node.js 18+
- An AtlaSent API key (`ask_live_*`)

## Run

```bash
ATLASENT_API_KEY=ask_live_your_key npx ts-node typescript/quickstart/index.ts
```

Or with a self-hosted deployment:

```bash
ATLASENT_API_KEY=ask_live_xxx ATLASENT_BASE_URL=https://your-atlasent.example.com \
  npx ts-node typescript/quickstart/index.ts
```

## What it does

| Step | Action | Success signal |
|------|--------|----------------|
| 1 | Verify API key and connectivity | `GET /v1/api-key-self` returns key metadata |
| 2 | Run first `evaluate` call | Returns decision + evaluation ID |
| 3 | Verify permit token | Confirms cryptographic proof |
| 4 | Print next steps | — |

## Output

```
 AtlaSent Pilot Quickstart

  API: https://api.atlasent.io
  Key: ask_live_xxx...

  ✓  Step 1/4  Verify connectivity
  ✓  Step 2/4  Run first evaluate call
       decision=allow  latency=187ms  evaluation_id=pt_abc123
  ✓  Step 3/4  Verify permit token
       verified=true  outcome=verified

  Quickstart complete!

  Decision:      allow
  Evaluation ID: pt_abc123
  Permit:        pt_abcdefghij...

  Audit proof: GET https://api.atlasent.io/v1/decisions/pt_abc123
  Verify:      atlasent verify-permit pt_abcdefghij...
```

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `ATLASENT_API_KEY is required` | Missing env var | Set the env var |
| `403 Forbidden` | Invalid or expired key | Check key status in console |
| `decision=deny` | No policy published yet | Publish a policy bundle for `ai.code.review` |
