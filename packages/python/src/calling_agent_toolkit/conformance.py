# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Vasik Mansuri
"""Framework-agnostic conformance checks every JSON media adapter must pass.

Wrap them in your test runner, e.g. with pytest:

    @pytest.mark.parametrize("check", media_conformance_checks(target), ids=lambda c: c.name)
    async def test_conformance(check): await check.run()
"""

from __future__ import annotations

import asyncio
import base64
import dataclasses
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Any

from .capabilities import undeclared_capabilities
from .errors import ProviderError
from .media_session import MediaSessionOptions
from .types import AudioFormat, TelephonyEvent


class RecordingConnection:
    """In-memory MediaConnection that records what an adapter sends."""

    def __init__(self) -> None:
        self.sent: list[str] = []
        self.binary: list[bytes] = []
        self.close_count = 0

    async def send_text(self, data: str) -> None:
        self.sent.append(data)

    async def send_binary(self, data: bytes) -> None:
        self.binary.append(data)

    async def close(self, code: int | None = None, reason: str | None = None) -> None:
        self.close_count += 1


@dataclass(frozen=True)
class StreamIds:
    call_id: str
    session_id: str


@dataclass(frozen=True)
class MediaConformanceTarget:
    """What the suite needs to drive a JSON media adapter without knowing its protocol."""

    name: str
    create_adapter: Callable[[], Any]
    #: Normalized format announced by start_message.
    input_format: AudioFormat
    start_message: Callable[[StreamIds], str]
    #: A one-track media message carrying payload_base64, already in input_format byte layout.
    media_message: Callable[[StreamIds, str, int], str]
    #: Provider's in-band stop message, when the protocol documents one.
    stop_message: Callable[[StreamIds], str] | None = None
    session_options: MediaSessionOptions = dataclasses.field(default_factory=MediaSessionOptions)


@dataclass(frozen=True)
class ConformanceCheck:
    name: str
    run: Callable[[], Awaitable[None]]


class ConformanceError(AssertionError):
    pass


def _check(condition: object, message: str) -> None:
    if not condition:
        raise ConformanceError(message)


async def _expect_code(fn: Callable[[], Any], codes: Sequence[str], what: str) -> None:
    try:
        result = fn()
        if asyncio.iscoroutine(result):
            await result
    except ProviderError as err:
        _check(err.code in codes, f"{what}: expected {' or '.join(codes)}, got {err.code}")
        return
    raise ConformanceError(f"{what}: expected {' or '.join(codes)}, but nothing was raised")


async def _drain(session: Any) -> list[TelephonyEvent]:
    return [event async for event in session.events()]


_IDS = StreamIds("conformance-call-1", "conformance-stream-1")
_PAYLOAD = base64.b64encode(b"\x7f" * 8).decode()


def media_conformance_checks(target: MediaConformanceTarget) -> list[ConformanceCheck]:
    def open_(**extra: Any) -> tuple[Any, RecordingConnection]:
        connection = RecordingConnection()
        options = dataclasses.replace(target.session_options, **extra)
        return target.create_adapter().create_session(connection, options), connection

    def started(ids: StreamIds = _IDS, **extra: Any) -> tuple[Any, RecordingConnection]:
        session, connection = open_(**extra)
        session.receive(target.start_message(ids))
        return session, connection

    async def declares_everything() -> None:
        _check(not undeclared_capabilities(target.create_adapter().capabilities()), "adapter leaves capabilities undeclared")
        session, _ = open_()
        _check(not undeclared_capabilities(session.capabilities()), "session leaves capabilities undeclared")

    async def rejects_non_json() -> None:
        session, _ = open_()
        await _expect_code(lambda: session.receive("{not json"), ["malformed_message"], "non-JSON")
        await _expect_code(lambda: session.receive(b"\xff\xfe"), ["malformed_message"], "invalid UTF-8")

    async def rejects_early_media() -> None:
        session, _ = open_()
        await _expect_code(lambda: session.receive(target.media_message(_IDS, _PAYLOAD, 1)), ["protocol_violation"], "early media")
        _check(session.state == "awaiting_start", "state changed after a rejected message")

    async def normalizes() -> None:
        session, _ = started()
        session.receive(target.media_message(_IDS, _PAYLOAD, 2))
        await session.close()
        events = await _drain(session)
        _check(len(events) == 3, f"expected 3 events, got {len(events)}")
        start, audio, stop = events
        _check(start.type == "stream_started", "first event is not stream_started")
        _check(start.data["format"] == target.input_format, "start format mismatch")
        _check(audio.type == "audio", "second event is not audio")
        frame = audio.data["frame"]
        _check((frame.call_id, frame.session_id) == (_IDS.call_id, _IDS.session_id), "frame ids mismatch")
        _check(len(frame.payload) == 8, "payload length changed")
        _check(frame.format == target.input_format, "frame format mismatch")
        _check(stop.type == "stream_stopped" and stop.data["reason"] == "socket_closed", "close did not emit socket_closed")

    async def payload_limit() -> None:
        session, _ = started(max_payload_bytes=4)
        await _expect_code(lambda: session.receive(target.media_message(_IDS, _PAYLOAD, 2)), ["buffer_overflow"], "oversized payload")

    async def drops_audio() -> None:
        session, _ = started(max_queued_events=2)
        for i in range(2, 6):
            session.receive(target.media_message(_IDS, _PAYLOAD, i))
        _check(session.dropped_audio_frames == 3, f"expected 3 dropped frames, got {session.dropped_audio_frames}")

    async def close_idempotent() -> None:
        session, connection = started()
        await session.close()
        await session.close()
        _check(connection.close_count == 1, f"connection closed {connection.close_count} times")
        events = await _drain(session)
        _check(sum(e.type == "stream_stopped" for e in events) == 1, "expected exactly one stream_stopped")
        await _expect_code(lambda: session.receive(target.media_message(_IDS, _PAYLOAD, 3)), ["session_closed"], "receive after close")

    async def isolated() -> None:
        other = StreamIds("conformance-call-2", "conformance-stream-2")
        a, _ = started()
        b, _ = started(other)
        a.receive(target.media_message(_IDS, _PAYLOAD, 2))
        b.receive(target.media_message(other, _PAYLOAD, 2))
        await asyncio.gather(a.close(), b.close())
        ea, eb = await asyncio.gather(_drain(a), _drain(b))
        _check(all(e.call_id == _IDS.call_id for e in ea), "session A received foreign events")
        _check(all(e.call_id == other.call_id for e in eb), "session B received foreign events")

    async def refuses_playback() -> None:
        session, connection = started(bidirectional=False)
        payload = base64.b64decode(_PAYLOAD)
        await _expect_code(lambda: session.send_audio(payload, target.input_format), ["unsupported_capability"], "send_audio")
        await _expect_code(session.clear_playback, ["unsupported_capability"], "clear_playback")
        _check(not connection.sent, "adapter wrote to the connection despite refusing")

    checks = [
        ConformanceCheck("declares every capability on the adapter and the session", declares_everything),
        ConformanceCheck("rejects non-JSON input with malformed_message", rejects_non_json),
        ConformanceCheck("rejects media before start with protocol_violation", rejects_early_media),
        ConformanceCheck("normalizes start and media into schema events with matching ids and format", normalizes),
        ConformanceCheck("enforces max_payload_bytes with buffer_overflow", payload_limit),
        ConformanceCheck("drops audio instead of raising when the consumer falls behind", drops_audio),
        ConformanceCheck("close is idempotent and closes the connection once", close_idempotent),
        ConformanceCheck("keeps concurrent sessions isolated", isolated),
        ConformanceCheck("refuses playback on a unidirectional stream without sending anything", refuses_playback),
    ]

    stop_message = target.stop_message
    if stop_message is not None:

        async def provider_stop() -> None:
            session, _ = started()
            session.receive(stop_message(_IDS))
            events = await _drain(session)
            _check(events and events[-1].type == "stream_stopped" and events[-1].data["reason"] == "provider_stop",
                   "last event is not provider_stop")
            await _expect_code(lambda: session.receive(target.media_message(_IDS, _PAYLOAD, 3)), ["session_closed"], "receive after stop")

        checks.append(ConformanceCheck("provider stop ends the event stream", provider_stop))
    return checks
