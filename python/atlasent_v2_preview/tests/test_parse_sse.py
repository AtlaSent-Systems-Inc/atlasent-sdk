"""SSE parser test suite — Python sibling of
``typescript/packages/v2-preview/test/parseSse.test.ts``.

Builds canonical SSE wire frames, encodes them, and runs the parser
over chunked / non-chunked / cross-chunk-boundary variants. Same
coverage matrix as the TS tests so cross-language parity is locked
on the Pillar 3 wire surface in addition to Pillar 9.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator

import pytest

from atlasent_v2_preview import (
    ConsumedEvent,
    DecisionEvent,
    EscalatedEvent,
    HoldResolvedEvent,
    PermitIssuedEvent,
    RateLimitStateEvent,
    RevokedEvent,
    UnknownDecisionEvent,
    VerifiedEvent,
    parse_decision_event_stream,
)

pytestmark = pytest.mark.asyncio


async def from_chunks(*chunks: str) -> AsyncIterator[bytes]:
    for c in chunks:
        yield c.encode("utf-8")


async def collect(source: AsyncIterator[bytes]) -> list[DecisionEvent]:
    out: list[DecisionEvent] = []
    async for ev in parse_decision_event_stream(source):
        out.append(ev)
    return out


def frame(event_type: str, data: dict, event_id: str | None = None) -> str:
    out = ""
    if event_id is not None:
        out += f"id: {event_id}\n"
    out += f"event: {event_type}\n"
    out += f"data: {json.dumps(data)}\n\n"
    return out


# ── Each known event type, with isinstance narrowing ────────────────


class TestKnownEventTypes:
    async def test_permit_issued(self):
        data = {
            "id": "1",
            "type": "permit_issued",
            "org_id": "org-1",
            "emitted_at": "2026-04-24T12:00:00Z",
            "permit_id": "dec_abc",
            "actor_id": "deploy-bot",
            "payload": {
                "decision": "allow",
                "agent": "deploy-bot",
                "action": "deploy_to_production",
                "audit_hash": "a" * 64,
                "reason": "GxP-compliant",
            },
        }
        events = await collect(from_chunks(frame("permit_issued", data, "1")))
        assert len(events) == 1
        ev = events[0]
        assert isinstance(ev, PermitIssuedEvent)
        assert ev.payload.decision == "allow"
        assert ev.payload.audit_hash == "a" * 64
        assert ev.permit_id == "dec_abc"

    async def test_verified(self):
        data = {
            "id": "2",
            "type": "verified",
            "org_id": "o",
            "emitted_at": "t",
            "permit_id": "dec_a",
            "actor_id": None,
            "payload": {"permit_hash": "h" * 64, "outcome": "ok"},
        }
        events = await collect(from_chunks(frame("verified", data, "2")))
        assert isinstance(events[0], VerifiedEvent)
        assert events[0].payload.outcome == "ok"
        assert events[0].actor_id is None

    async def test_consumed(self):
        data = {
            "id": "3",
            "type": "consumed",
            "org_id": "o",
            "emitted_at": "t",
            "permit_id": "dec_a",
            "payload": {
                "proof_id": "550e8400-e29b-41d4-a716-446655440000",
                "execution_status": "executed",
                "audit_hash": "b" * 64,
            },
        }
        events = await collect(from_chunks(frame("consumed", data, "3")))
        assert isinstance(events[0], ConsumedEvent)
        assert events[0].payload.execution_status == "executed"

    async def test_revoked_with_null_revoker(self):
        data = {
            "id": "4",
            "type": "revoked",
            "org_id": "o",
            "emitted_at": "t",
            "permit_id": "dec_a",
            "payload": {"reason": "ttl_expired", "revoker_id": None},
        }
        events = await collect(from_chunks(frame("revoked", data, "4")))
        assert isinstance(events[0], RevokedEvent)
        assert events[0].payload.revoker_id is None

    async def test_escalated(self):
        data = {
            "id": "5",
            "type": "escalated",
            "org_id": "o",
            "emitted_at": "t",
            "permit_id": "dec_a",
            "payload": {"to": "compliance-queue", "reason": "manual_review"},
        }
        events = await collect(from_chunks(frame("escalated", data, "5")))
        assert isinstance(events[0], EscalatedEvent)
        assert events[0].payload.to == "compliance-queue"

    async def test_hold_resolved(self):
        data = {
            "id": "6",
            "type": "hold_resolved",
            "org_id": "o",
            "emitted_at": "t",
            "permit_id": "dec_a",
            "payload": {"resolution": "approved", "resolved_by": "operator-1"},
        }
        events = await collect(from_chunks(frame("hold_resolved", data, "6")))
        assert isinstance(events[0], HoldResolvedEvent)
        assert events[0].payload.resolution == "approved"

    async def test_rate_limit_state_no_permit_id(self):
        data = {
            "id": "7",
            "type": "rate_limit_state",
            "org_id": "o",
            "emitted_at": "t",
            "payload": {"limit": 1000, "remaining": 50, "reset_at": 1714070000},
        }
        events = await collect(from_chunks(frame("rate_limit_state", data, "7")))
        assert isinstance(events[0], RateLimitStateEvent)
        assert events[0].payload.remaining == 50
        assert events[0].permit_id is None


# ── Wire shape ───────────────────────────────────────────────────────


class TestWireShape:
    async def test_multiple_events_in_one_chunk(self):
        data1 = {
            "id": "1",
            "type": "permit_issued",
            "org_id": "o",
            "emitted_at": "t1",
            "permit_id": "dec_a",
            "payload": {
                "decision": "allow",
                "agent": "a",
                "action": "x",
                "audit_hash": "a" * 64,
            },
        }
        data2 = {
            "id": "2",
            "type": "verified",
            "org_id": "o",
            "emitted_at": "t2",
            "permit_id": "dec_a",
            "payload": {"permit_hash": "h" * 64, "outcome": "ok"},
        }
        wire = frame("permit_issued", data1, "1") + frame("verified", data2, "2")
        events = await collect(from_chunks(wire))
        assert [e.type for e in events] == ["permit_issued", "verified"]
        assert [e.id for e in events] == ["1", "2"]

    async def test_event_split_across_chunks(self):
        data = {
            "id": "1",
            "type": "consumed",
            "org_id": "o",
            "emitted_at": "t",
            "permit_id": "dec_a",
            "payload": {
                "proof_id": "p",
                "execution_status": "executed",
                "audit_hash": "a" * 64,
            },
        }
        wire = frame("consumed", data, "1")
        # Slice into many small chunks.
        chunks = [wire[i : i + 7] for i in range(0, len(wire), 7)]
        events = await collect(from_chunks(*chunks))
        assert len(events) == 1
        assert isinstance(events[0], ConsumedEvent)

    async def test_heartbeat_lines_ignored(self):
        data = {
            "id": "1",
            "type": "verified",
            "org_id": "o",
            "emitted_at": "t",
            "permit_id": "dec_a",
            "payload": {"permit_hash": "h" * 64, "outcome": "ok"},
        }
        wire = (
            ":heartbeat\n"
            ":another comment\n\n"
            f"{frame('verified', data, '1')}"
            ":trailing\n"
        )
        events = await collect(from_chunks(wire))
        assert len(events) == 1

    async def test_crlf_line_endings(self):
        data = {
            "id": "1",
            "type": "verified",
            "org_id": "o",
            "emitted_at": "t",
            "permit_id": "dec_a",
            "payload": {"permit_hash": "h" * 64, "outcome": "ok"},
        }
        wire = (
            f"id: 1\r\nevent: verified\r\ndata: {json.dumps(data)}\r\n\r\n"
        )
        events = await collect(from_chunks(wire))
        assert len(events) == 1

    async def test_multiline_data_concatenates_with_newline(self):
        # Pretty-printed JSON across multiple data: lines.
        wire = (
            "event: verified\n"
            "data: {\n"
            'data:   "id": "1",\n'
            'data:   "type": "verified",\n'
            'data:   "org_id": "o",\n'
            'data:   "emitted_at": "t",\n'
            'data:   "permit_id": "dec_a",\n'
            'data:   "payload": { "permit_hash": "h", "outcome": "ok" }\n'
            "data: }\n\n"
        )
        events = await collect(from_chunks(wire))
        assert len(events) == 1
        assert events[0].id == "1"

    async def test_missing_trailing_blank_line_still_flushes(self):
        data = {
            "id": "1",
            "type": "verified",
            "org_id": "o",
            "emitted_at": "t",
            "permit_id": "dec_a",
            "payload": {"permit_hash": "h", "outcome": "ok"},
        }
        # Note: payload.permit_hash here intentionally short — the
        # field's pydantic model allows any string for outcome/hash so
        # this still validates.
        wire = f"event: verified\ndata: {json.dumps(data)}"
        events = await collect(from_chunks(wire))
        assert len(events) == 1
        assert events[0].type == "verified"

    async def test_unknown_event_type_passes_through(self):
        data = {
            "id": "1",
            "type": "future_event_type_v3",
            "org_id": "o",
            "emitted_at": "t",
            "payload": {"something_new": 42},
        }
        events = await collect(from_chunks(frame("future_event_type_v3", data, "1")))
        assert len(events) == 1
        ev = events[0]
        assert isinstance(ev, UnknownDecisionEvent)
        assert ev.type == "future_event_type_v3"
        assert ev.payload == {"something_new": 42}

    async def test_unknown_payload_field_on_known_type(self):
        data = {
            "id": "1",
            "type": "verified",
            "org_id": "o",
            "emitted_at": "t",
            "permit_id": "dec_a",
            "payload": {
                "permit_hash": "h",
                "outcome": "ok",
                "server_only_field": "x",
            },
        }
        events = await collect(from_chunks(frame("verified", data, "1")))
        assert isinstance(events[0], VerifiedEvent)
        # extra="allow" preserves unknown fields on the payload model.
        assert events[0].payload.model_extra == {"server_only_field": "x"}

    async def test_malformed_json_raises(self):
        wire = "event: verified\ndata: {not valid json}\n\n"
        with pytest.raises(ValueError, match="invalid JSON"):
            await collect(from_chunks(wire))

    async def test_non_object_data_raises(self):
        wire = "event: verified\ndata: [1,2,3]\n\n"
        with pytest.raises(ValueError, match="must be a JSON object"):
            await collect(from_chunks(wire))

    async def test_trusts_json_id_type_over_sse_field_lines(self):
        data = {
            "id": "1",
            "type": "consumed",
            "org_id": "o",
            "emitted_at": "t",
            "permit_id": "dec_a",
            "payload": {
                "proof_id": "p",
                "execution_status": "executed",
                "audit_hash": "a" * 64,
            },
        }
        # SSE layer says id:99, type:permit_issued; JSON wins.
        wire = f"id: 99\nevent: permit_issued\ndata: {json.dumps(data)}\n\n"
        events = await collect(from_chunks(wire))
        assert events[0].id == "1"
        assert isinstance(events[0], ConsumedEvent)

    async def test_empty_blank_lines_dispatch_nothing(self):
        events = await collect(from_chunks("\n\n\n"))
        assert events == []

    async def test_trailing_event_or_id_line_no_data_drops_cleanly(self):
        # EOF mid-event-header without a data: line — buffered fields
        # discarded silently.
        assert await collect(from_chunks("event: verified")) == []
        assert await collect(from_chunks("id: 99")) == []

    async def test_trailing_data_without_blank_line_dispatches(self):
        data = {
            "id": "1",
            "type": "consumed",
            "org_id": "o",
            "emitted_at": "t",
            "permit_id": "dec_a",
            "payload": {
                "proof_id": "p",
                "execution_status": "executed",
                "audit_hash": "a" * 64,
            },
        }
        wire = f"event: consumed\nid: 1\ndata: {json.dumps(data)}"
        events = await collect(from_chunks(wire))
        assert len(events) == 1
        assert events[0].id == "1"

    async def test_retry_field_silently_ignored(self):
        data = {
            "id": "1",
            "type": "verified",
            "org_id": "o",
            "emitted_at": "t",
            "permit_id": "dec_a",
            "payload": {"permit_hash": "h", "outcome": "ok"},
        }
        wire = f"retry: 5000\n{frame('verified', data, '1')}"
        events = await collect(from_chunks(wire))
        assert len(events) == 1

    async def test_field_line_no_colon_treated_as_empty_value(self):
        data = {
            "id": "1",
            "type": "verified",
            "org_id": "o",
            "emitted_at": "t",
            "permit_id": "dec_a",
            "payload": {"permit_hash": "h", "outcome": "ok"},
        }
        wire = f"data\nevent: verified\ndata: {json.dumps(data)}\n\n"
        events = await collect(from_chunks(wire))
        assert len(events) == 1

    async def test_id_with_nul_dropped(self):
        data = {
            "id": "1",
            "type": "verified",
            "org_id": "o",
            "emitted_at": "t",
            "permit_id": "dec_a",
            "payload": {"permit_hash": "h", "outcome": "ok"},
        }
        wire = f"id: bad\0id\nevent: verified\ndata: {json.dumps(data)}\n\n"
        events = await collect(from_chunks(wire))
        assert len(events) == 1
        # JSON id wins anyway.
        assert events[0].id == "1"


# ── UTF-8 boundary handling ──────────────────────────────────────────


class TestUtf8Boundaries:
    async def test_multibyte_char_split_across_chunks(self):
        # "漢" is 3 bytes in UTF-8: e6 bc a2. Split it across chunks
        # to exercise the incremental decoder. Use ensure_ascii=False
        # so the kanji survives JSON encoding as raw UTF-8 rather than
        # the \\u6f22 escape sequence.
        data = {
            "id": "1",
            "type": "verified",
            "org_id": "org-漢",
            "emitted_at": "t",
            "permit_id": "dec_a",
            "payload": {"permit_hash": "h", "outcome": "ok"},
        }
        body = json.dumps(data, ensure_ascii=False)
        wire = (f"id: 1\nevent: verified\ndata: {body}\n\n").encode()
        kanji_idx = wire.index(b"\xe6\xbc\xa2")

        async def chunked() -> AsyncIterator[bytes]:
            yield wire[: kanji_idx + 1]  # first byte of 漢
            yield wire[kanji_idx + 1 :]  # rest

        events = await collect(chunked())
        assert len(events) == 1
        assert events[0].org_id == "org-漢"

    async def test_flush_replaces_invalid_trailing_bytes(self):
        # If a stream ends mid-multi-byte sequence, the parser should
        # flush gracefully (errors="replace") rather than swallowing
        # the whole event. Build a valid event then append a stray
        # 0xC0 byte at the very end.
        data = {
            "id": "1",
            "type": "verified",
            "org_id": "o",
            "emitted_at": "t",
            "permit_id": "dec_a",
            "payload": {"permit_hash": "h", "outcome": "ok"},
        }
        full = frame("verified", data, "1").encode("utf-8")

        async def gen() -> AsyncIterator[bytes]:
            yield full
            yield b"\xc0"  # truncated multi-byte head

        events = await collect(gen())
        # The valid event came through cleanly before the bad trailing byte.
        assert len(events) == 1
        assert events[0].type == "verified"
