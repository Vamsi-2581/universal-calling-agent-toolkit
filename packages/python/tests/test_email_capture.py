from __future__ import annotations

import asyncio
import json
from dataclasses import asdict
from pathlib import Path
from typing import Any

import pytest

from calling_agent_toolkit import ProviderError
from calling_agent_toolkit.email_capture import (
    EmailCapture,
    EmailFound,
    InMemoryEmailStateStore,
    TranscriptEvent,
    extract_email,
)

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"


def load(path: str) -> Any:
    return json.loads((CONTRACTS / path).read_text())


def to_wire(found: Any) -> Any:
    if found is None:
        return None
    data = asdict(found)
    return data


@pytest.mark.parametrize("case", load("fixtures/email/extraction.json")["cases"], ids=lambda c: repr(c["text"]))
def test_extract_email(case: dict[str, Any]) -> None:
    assert to_wire(extract_email(case["text"])) == case["expect"]


def event_from(raw: dict[str, Any], tenant_id: str, session_id: str) -> TranscriptEvent:
    return TranscriptEvent(
        event_id=raw["eventId"],
        tenant_id=raw.get("tenantId", tenant_id),
        session_id=raw.get("sessionId", session_id),
        turn_id=raw["turnId"],
        kind=raw.get("kind", "final"),
        text=raw["text"],
        revision=raw.get("revision", 0),
        confidence=raw.get("confidence"),
    )


ACTIONS = {"questionAsked": "question_asked", "confirm": "confirm", "reject": "reject"}


@pytest.mark.parametrize("case", load("fixtures/email/sessions.json")["cases"], ids=lambda c: c["name"])
async def test_email_sessions(case: dict[str, Any]) -> None:
    store = InMemoryEmailStateStore()
    engines = {"A": EmailCapture(store=store), "B": EmailCapture(store=store)}
    for i, step in enumerate(case["steps"]):
        engine = engines[step.get("engine", "A")]
        tenant_id = step.get("tenantId", "t1")
        session_id = step.get("sessionId", "s1")
        if "event" in step:
            event = event_from(step["event"], tenant_id, session_id)
            tenant_id, session_id = event.tenant_id, event.session_id
            results = await engine.handle(event)
        else:
            results = await getattr(engine, ACTIONS[step["action"]])(tenant_id, session_id)
        assert results == step["expect"], f"step {i}"
        if "expectState" in step:
            state = await engine.get_state(tenant_id, session_id)
            assert {k: state[k] for k in ("status", "email", "candidate")} == step["expectState"], f"step {i}"


async def test_concurrent_events_are_serialized() -> None:
    capture = EmailCapture()
    events = [
        TranscriptEvent(f"e{i}", "t", "s", f"u{i}", "final", f"my email is {name} at x dot com")
        for i, name in enumerate("abc")
    ]
    results = await asyncio.gather(*(capture.handle(e) for e in events))
    assert [r["type"] for batch in results for r in batch] == ["candidate"] * 3
    assert (await capture.get_state("t", "s"))["candidate"] == "c@x.com"


async def test_rejects_events_without_ids() -> None:
    with pytest.raises(ProviderError, match="event_id"):
        await EmailCapture().handle(TranscriptEvent("", "t", "s", "u", "final", ""))


def test_found_is_plain_data() -> None:
    assert EmailFound("a@b.co", literal=True).kind == "email"
