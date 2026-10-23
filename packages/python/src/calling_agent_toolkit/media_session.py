from __future__ import annotations

import json
import time
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator, Callable, Sequence
from dataclasses import dataclass, replace
from typing import Any

from .adapters import MediaConnection, MediaSessionState
from .audio import frame_to_wire
from .capabilities import require_capability
from .errors import ProviderError
from .parse import JsonObject, MessageReader
from .queue import BoundedQueue
from .types import (
    AudioFormat,
    AudioFrame,
    Capability,
    CapabilityEntry,
    ProviderCapabilities,
    StreamStopReason,
    TelephonyEvent,
)

DEFAULT_MAX_QUEUED_EVENTS = 500
DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024
DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024


@dataclass(frozen=True)
class MediaSessionOptions:
    #: Whether the host started the stream in bidirectional mode. Providers rarely say so in-band.
    bidirectional: bool | None = None
    max_queued_events: int = DEFAULT_MAX_QUEUED_EVENTS
    max_payload_bytes: int = DEFAULT_MAX_PAYLOAD_BYTES
    max_message_bytes: int = DEFAULT_MAX_MESSAGE_BYTES
    now: Callable[[], float] | None = None


def resolve_bidirectional(
    caps: ProviderCapabilities, dependent: Sequence[Capability], bidirectional: bool | None
) -> ProviderCapabilities:
    """Resolve capabilities that depend on how the stream was started. None keeps requires_configuration."""
    if bidirectional is None:
        return caps
    entry = (
        CapabilityEntry("supported")
        if bidirectional
        else CapabilityEntry("unsupported", "This stream was started unidirectional.")
    )
    return replace(caps, capabilities={**caps.capabilities, **{c: entry for c in dependent}})


def format_to_wire(fmt: AudioFormat) -> dict[str, Any]:
    return {"encoding": fmt.encoding, "sampleRate": fmt.sample_rate, "channels": fmt.channels}


def event_to_wire(event: TelephonyEvent) -> dict[str, Any]:
    """Wire form of a TelephonyEvent, matching core.schema.json."""
    out: dict[str, Any] = {
        "type": event.type,
        "provider": event.provider,
        "callId": event.call_id,
        "sessionId": event.session_id,
        "receivedAtMs": event.received_at_ms,
        "providerSequence": event.provider_sequence,
    }
    for key, value in event.data.items():
        if isinstance(value, AudioFrame):
            value = frame_to_wire(value)
        elif isinstance(value, AudioFormat):
            value = format_to_wire(value)
        out[key] = value
    return out


class BaseMediaSession(ABC):
    """Shared lifecycle for JSON-over-WebSocket media protocols: state machine, bounded event queue,
    size limits and outbound capability checks. Subclasses only translate provider messages."""

    def __init__(
        self,
        provider: str,
        connection: MediaConnection,
        capabilities: ProviderCapabilities,
        bidirectional_dependent: Sequence[Capability],
        options: MediaSessionOptions | None = None,
    ) -> None:
        options = options or MediaSessionOptions()
        self.provider = provider
        self.state: MediaSessionState = "awaiting_start"
        self.call_id: str | None = None
        self.session_id: str | None = None
        self.input_format: AudioFormat | None = None
        self.reader = MessageReader(provider)
        #: Name of the JSON field that carries the message type.
        self.event_field = "event"
        self.max_payload_bytes = options.max_payload_bytes
        self.bidirectional = options.bidirectional
        self._max_message_bytes = options.max_message_bytes
        self._connection = connection
        self._base_capabilities = capabilities
        self._dependent = tuple(bidirectional_dependent)
        self._now = options.now or (lambda: time.time() * 1000)
        self._queue: BoundedQueue[TelephonyEvent] = BoundedQueue(options.max_queued_events, "reject", provider)
        self._connection_closed = False
        self._dropped = 0
        self._ignored = 0

    def capabilities(self) -> ProviderCapabilities:
        return resolve_bidirectional(self._base_capabilities, self._dependent, self.bidirectional)

    @property
    def dropped_audio_frames(self) -> int:
        """Audio frames discarded because the consumer fell behind. Control events are never dropped."""
        return self._dropped

    @property
    def ignored_messages(self) -> int:
        """Well-formed messages with an event type this adapter does not know (forward compatibility)."""
        return self._ignored

    def events(self) -> AsyncIterator[TelephonyEvent]:
        return self._queue

    def receive(self, message: str | bytes) -> None:
        if self.state in ("closed", "closing"):
            raise self._error("session_closed", "The media session is closed.")
        size = len(message.encode("utf-8")) if isinstance(message, str) else len(message)
        if size > self._max_message_bytes:
            raise self._error(
                "buffer_overflow", f"Message of {size} bytes exceeds the {self._max_message_bytes}-byte limit."
            )
        self._handle(self.reader.json(message, self.event_field))

    async def close(self, reason: str | None = None) -> None:
        self._finish("socket_closed", None)
        if self._connection_closed:
            return
        self._connection_closed = True
        await self._connection.close(1000, reason)

    @abstractmethod
    async def send_audio(self, payload: bytes, fmt: AudioFormat) -> None: ...

    @abstractmethod
    async def send_mark(self, name: str) -> None: ...

    @abstractmethod
    async def clear_playback(self) -> None: ...

    @abstractmethod
    async def send_dtmf(self, digits: str) -> None: ...

    @abstractmethod
    def _handle(self, message: JsonObject) -> None: ...

    def _require_active(self, event: str) -> None:
        if self.state != "active":
            raise ProviderError(
                code="protocol_violation", provider=self.provider, message=f'Received "{event}" before the stream started.'
            )

    def _require_same_stream(self, stream_id: str | None) -> None:
        if stream_id is not None and stream_id != self.session_id:
            raise self._error(
                "protocol_violation", f"Message for stream {stream_id} arrived on session {self.session_id}."
            )

    def _begin(self, call_id: str, session_id: str, fmt: AudioFormat) -> None:
        if self.state != "awaiting_start":
            raise self._error("protocol_violation", "Received a second start message.")
        self.call_id = call_id
        self.session_id = session_id
        self.input_format = fmt
        self.state = "active"

    def _event(self, type_: Any, provider_sequence: int | None, **data: Any) -> TelephonyEvent:
        assert self.call_id is not None and self.session_id is not None
        return TelephonyEvent(
            type=type_,
            provider=self.provider,
            call_id=self.call_id,
            session_id=self.session_id,
            received_at_ms=self._now(),
            provider_sequence=provider_sequence,
            data=data,
        )

    def _emit(self, event: TelephonyEvent) -> None:
        if event.type == "audio":
            try:
                self._queue.push(event)
            except ProviderError as err:
                if err.code != "buffer_overflow":
                    raise
                self._dropped += 1
            return
        self._queue.push(event)

    def _ignore(self) -> None:
        self._ignored += 1

    def _finish(self, reason: StreamStopReason, provider_sequence: int | None) -> None:
        if self.state == "closed":
            return
        if self.state == "active":
            try:
                self._queue.push(self._event("stream_stopped", provider_sequence, reason=reason))
            except ProviderError:
                pass  # Queue full: closing the queue still ends iteration, which signals the stop.
        self.state = "closed"
        self._queue.close()

    async def _send_json(self, capability: Capability, message: JsonObject) -> None:
        """Capability check, state check, then write. Nothing is sent when any check fails."""
        require_capability(self.capabilities(), capability)
        if self.state != "active":
            early = self.state == "awaiting_start"
            raise self._error(
                "protocol_violation" if early else "session_closed",
                "Cannot send before the stream starts." if early else "The media session is closed.",
                capability,
            )
        await self._connection.send_text(json.dumps(message, separators=(",", ":")))

    def _invalid(self, message: str, capability: Capability | None = None) -> ProviderError:
        return self._error("invalid_configuration", message, capability)

    def _error(self, code: Any, message: str, capability: Capability | None = None) -> ProviderError:
        return ProviderError(
            code=code,
            provider=self.provider,
            message=message,
            capability=capability,
            call_id=self.call_id,
            session_id=self.session_id,
        )
