# YC Demo Plan — `clinical-data-agent` three-arc

Status: **draft, pre-recording.** This doc captures the demo narrative,
the SDK / server prerequisites, and the exact script the demo binary
will run on stage. Owner: demo recording session.

## Narrative

Same agent. Same action. Same world. The only thing that changes
between calls is **who attested to the QA approval**, and AtlaSent's
policy reflects that change without any code change in the agent.

| # | What the agent sends                              | Decision | Why                                          |
|---|---------------------------------------------------|----------|----------------------------------------------|
| 1 | `qa_signed=False`                                 | DENY     | No QA approval on file                       |
| 2 | `qa_signed=True`, `qa_reviewer_kind="agent"`      | DENY     | Reviewer must be human (the AtlaSent moment) |
| 3 | `qa_signed=True`, `qa_reviewer_kind="human"`      | ALLOW    | Real human attestation; permit issued        |

Arc 2 is the punchline: an LLM agent cannot self-approve a high-risk
action by setting a string, because the policy gates on
`qa_reviewer_kind` **and** on `qa_reviewer_id != agent_id`. The
combination is what makes the assertion non-spoofable in the demo
context.

### The trust-anchor line (do not skip on stage)

Right after Attempt 2 denies, the presenter says, verbatim:

> "In production, the reviewer identity isn't coming from the agent —
> it's verified from a signed approval. The agent can't spoof this."

This closes the obvious investor objection ("what stops the agent from
just setting `qa_reviewer_kind='human'`?") and redirects the audience
from "agent-controlled string" to "verifiable upstream attestation."
The optional `approval_source: "signed_record"` field in Arc 3
(below) is the on-screen handle for that line.

### What each arc tells the audience

- **Attempt 1 → "There's a rule."** Policy enforcement exists.
- **Attempt 2 → "You can't fake satisfying the rule."** Self-asserted
  authority is rejected. ← **the AtlaSent thesis**
- **Attempt 3 → "Only real authority unlocks execution."** Decision
  becomes a permit, permit becomes the gate on downstream effect.

That's the whole product in ~15 seconds.

## Prerequisites

These must all be true before recording. Each is independently
verifiable.

### 1. SDK 2.0.0 wire format

The PyPI-published SDK (`atlasent==1.4.1`) sends the legacy
`{action, agent, api_key, context}` body, which the upgraded server
now rejects with `400 MISSING_REQUIRED_FIELDS`. Fix:

- Land `python/atlasent` 2.0.0 (already in this repo, unreleased).
- Verify `EvaluateRequest(...).model_dump(by_alias=True)` emits
  `{action_type, actor_id, context}` — confirmed locally against
  pydantic 2.13.
- Either publish to PyPI **or** install on the demo laptop from
  source:
  ```bash
  pip install --upgrade \
    "git+https://github.com/AtlaSent-Systems-Inc/atlasent-sdk.git#subdirectory=python"
  ```

### 2. Action + policy registered server-side

Until `modify_patient_record` exists in the policy catalog the call
returns `deny / Action "modify_patient_record" not found` regardless
of context, which kills the three-arc story.

In the AtlaSent console for the org behind
`ask_live_dVJ3Nd…`:

1. Create action `modify_patient_record` (resource_type:
   `patient_record`).
2. Attach a policy equivalent to:
   ```
   allow if context.qa_signed == true
      and context.qa_reviewer_kind == "human"
      and context.qa_reviewer_id != actor_id     ← blocks self-approval
   deny  with reason "QA reviewer must be human, not the requesting agent"
        if context.qa_signed == true
       and (context.qa_reviewer_kind != "human"
            or context.qa_reviewer_id == actor_id)
   deny  with reason "Missing QA approval"
        otherwise
   ```
   The `qa_reviewer_id != actor_id` clause is what makes the agent
   physically unable to satisfy the rule by self-attestation, even if
   it sets `qa_reviewer_kind="human"`.
3. Confirm `enforcement_mode: enforce` (not `shadow` — shadow keys
   evaluate but skip `event_written: true`, so nothing lands in the
   console feed).

Owner: console operator (not in this repo). This doc is the
checklist; the actual wiring lives in `atlasent-api`.

### 3. Console feed visible to the demo presenter

- Logged in as the org that owns the `ask_live_…` key.
- **Audit → Events** tab open, filter cleared, time range "last 1
  hour".
- Pre-stage: run a smoke `authorize()` to confirm a row appears
  before going live.

## Demo script (`demo.py`)

Drop-in for `/Users/wac/PycharmProjects/yc-demo/demo.py`. Three
calls, distinct contexts, single shared `show()` formatter.

```python
import atlasent
from atlasent import authorize
from rich import print
from dotenv import load_dotenv

load_dotenv()

atlasent.configure(
    api_key="ask_live_dVJ3NdnCt6HVZD4FxNBgrnnUTWTVDaeWqEme8osG",
    base_url="https://ihghhasvxtltlbizvkqy.supabase.co/functions/v1",
)

AGENT = "clinical-data-agent"
ACTION = "modify_patient_record"
BASE_CTX = {"user": "dr_smith", "environment": "production"}


def show(r) -> None:
    color = "green" if r.permitted else "red"
    decision = "ALLOW" if r.permitted else "DENY"
    print(f"  decision: [bold {color}]{decision}[/]")
    print(f"  reason:   {r.reason}")
    token = (r.permit_token or "")[:60]
    print(f"  permit:   {token + '...' if token else '—'}")
    if r.permitted:
        print("  enforcement: [green]permit issued (required for execution)[/]\n")
    else:
        print("  enforcement: [red]execution blocked pre-flight[/]\n")


# Arc 1 — no QA signoff: "there's a rule"
print("[bold cyan]→ Attempt 1: agent requests modify_patient_record (no QA signoff)[/]")
r1 = authorize(
    agent=AGENT, action=ACTION,
    context={**BASE_CTX, "qa_signed": False},
)
show(r1)


# Arc 2 — agent self-attests: "you can't fake satisfying the rule"
print("[dim]Agent attempts to satisfy the policy by asserting reviewer identity...[/]")
print("[bold cyan]→ Attempt 2: agent self-attests as the QA reviewer[/]")
r2 = authorize(
    agent=AGENT, action=ACTION,
    context={
        **BASE_CTX,
        "qa_signed": True,
        "qa_reviewer_id": AGENT,
        "qa_reviewer_kind": "agent",
        "qa_signed_at": "2026-05-05T14:32:00Z",
    },
)
show(r2)
print("[bold yellow]→ AtlaSent rejects untrusted self-asserted authority[/]\n")


# Arc 3 — real human signoff: "only real authority unlocks execution"
print("[bold cyan]→ Attempt 3: human QA reviewer signs off, agent retries[/]")
r3 = authorize(
    agent=AGENT, action=ACTION,
    context={
        **BASE_CTX,
        "qa_signed": True,
        "qa_reviewer_id": "qa_jane_doe",
        "qa_reviewer_kind": "human",
        "qa_signed_at": "2026-05-05T14:35:00Z",
        "approval_source": "signed_record",
    },
)
show(r3)
if r3.permitted:
    print("[bold green]→ Execution is now authorized — downstream system can proceed[/]")
```

The `approval_source: "signed_record"` field in Arc 3 is the visible
hook for the trust-anchor line: *"in production this is a signed
approval artifact bound to the action."* It's not enforced by the demo
policy — it's there to telegraph the production direction without
requiring the signed-attestation pipeline to be live for the
recording.

## Recording sequence

1. Open the console **Audit → Events** tab side-by-side with the
   terminal.
2. Run `python demo.py`. Three blocks print, two red, one green; the
   yellow "AtlaSent rejects untrusted self-asserted authority" line
   lands between Attempt 2 and Attempt 3, and the green "Execution
   is now authorized" line lands after Attempt 3.
3. Deliver the trust-anchor line aloud the moment Attempt 2 denies
   (see Narrative §). Do not skip it.
4. Switch to console, refresh feed. Three new rows visible:
   - Two `evaluate.deny` rows with policy reasons.
   - One `evaluate.allow` row with the permit token from arc 3.
5. Click into the arc-3 row to show the full payload (context with
   `qa_reviewer_kind: human`, `approval_source: signed_record`) and
   the chained `hash` / `previous_hash` for tamper-evidence.

## Risks / what could go wrong on stage

- **PyPI not yet on 2.0.0.** Mitigation: install from source on the
  demo laptop and verify before recording (see §1).
- **Action not registered.** Symptom: all three arcs DENY with
  "Action … not found." Mitigation: smoke test before recording
  (see §3).
- **Shadow-mode key.** Symptom: arcs decide correctly but no rows
  appear in the console. Mitigation: confirm
  `enforcement_mode: enforce` on the key.
- **Console org mismatch.** Symptom: rows written but invisible.
  Mitigation: confirm the logged-in org owns the `ask_live_…` key.

## Out of scope for this PR

- Publishing 2.0.0 to PyPI (separate release PR; needs explicit
  go-ahead).
- Console action/policy wiring (lives in `atlasent-api`, not here).
- The demo recording itself.
