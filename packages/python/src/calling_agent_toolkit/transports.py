# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Vasik Mansuri
"""Provider-neutral transports for providers without a dedicated adapter.

- GenericJsonMediaTransport: configurable JSON-over-WebSocket parser (receive-only).
- RawPcmMediaSession: WebSockets that carry raw audio frames as binary messages.
- RTP (RFC 3550): parser, packetizer and session for SIP gateways, PBXs and Asterisk ExternalMedia.
- WAV: recordings for batch processing. Batch is never realtime.
"""

from __future__ import annotations

import struct
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Literal

from .adapters import MediaConnection, MediaSessionState, StreamConnectionRequest
from .audio import bytes_per_sample, swap_bytes16, validate_audio_payload
from .capabilities import require_capability
from .errors import ProviderError
from .media_session import (
    DEFAULT_MAX_PAYLOAD_BYTES,
    DEFAULT_MAX_QUEUED_EVENTS,
    BaseMediaSession,
    MediaSessionOptions,
)
from .parse import JsonObject
from .queue import BoundedQueue
from .types import (
    CAPABILITIES,
    SUPPORTED_SAMPLE_RATES,
    AudioFormat,
    AudioFrame,
    Capability,
    CapabilityEntry,
    MediaDirection,
    ProviderCapabilities,
    TelephonyEvent,
    TimestampKind,
)

_ADAPTER_VERSION = "0.1.0"


def _capabilities(provider: str, overrides: Mapping[Capability, CapabilityEntry]) -> ProviderCapabilities:
    caps: dict[Capability, CapabilityEntry] = {
        c: CapabilityEntry("unsupported", "Not offered by this generic transport.") for c in CAPABILITIES
    }
    caps.update(overrides)
    return ProviderCapabilities(provider=provider, adapter_version=_ADAPTER_VERSION, capabilities=caps)


def _invalid(provider: str, message: str) -> ProviderError:
    return ProviderError(code="invalid_configuration", provider=provider, message=message)


# ---------------------------------------------------------------------------------------------
# Generic JSON WebSocket


@dataclass(frozen=True)
class GenericJsonConfig:
    provider: str
    #: event names: {"start": ..., "media": ..., "stop": ... (optional)}
    events: Mapping[str, str]
    #: dot paths: callId, sessionId, payload, and optional track, sequence, timestamp
    paths: Mapping[str, str]
    #: The stream's audio format. Generic streams do not announce it in a standard way.
    format: AudioFormat
    event_field: str = "event"
    timestamp_kind: Literal["stream_relative_ms", "unix_epoch_ms"] = "stream_relative_ms"
    track_values: Mapping[str, MediaDirection] = field(default_factory=dict)
    default_track: MediaDirection = "inbound"
    pcm_byte_order: Literal["little", "big"] = "little"


def _split(path: str) -> tuple[list[str], str]:
    parts = path.split(".")
    return parts[:-1], parts[-1]


def _walk(obj: JsonObject, parts: list[str]) -> JsonObject | None:
    cur: Any = obj
    for part in parts:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur if isinstance(cur, dict) else None


class GenericJsonMediaTransport:
    """Receive-only adapter for JSON streams whose shape is described by configuration."""

    def __init__(
        self,
        config: GenericJsonConfig,
        *,
        connection_validator: Callable[[StreamConnectionRequest], Awaitable[bool]] | None = None,
    ) -> None:
        if not config.provider:
            raise _invalid("generic_json", "provider name is required.")
        if not config.events.get("start") or not config.events.get("media"):
            raise _invalid(config.provider, "events.start and events.media are required.")
        if config.format.sample_rate not in SUPPORTED_SAMPLE_RATES:
            raise _invalid(config.provider, f"Unsupported sample rate {config.format.sample_rate} Hz.")
        self.provider = config.provider
        self._config = config
        self._validator = connection_validator

    def capabilities(self) -> ProviderCapabilities:
        return _capabilities(
            self.provider,
            {
                "live_inbound_audio": CapabilityEntry("supported"),
                "separate_tracks": CapabilityEntry("supported")
                if self._config.paths.get("track")
                else CapabilityEntry("unsupported", "No track path configured."),
                "playback": CapabilityEntry(
                    "unsupported", "The generic JSON adapter is receive-only; write a provider adapter for playback."
                ),
                "stream_auth_validation": CapabilityEntry("supported", "Uses the host-supplied connection_validator.")
                if self._validator
                else CapabilityEntry("requires_configuration", "Pass connection_validator."),
            },
        )

    async def validate_connection(self, req: StreamConnectionRequest) -> None:
        require_capability(self.capabilities(), "stream_auth_validation")
        assert self._validator is not None
        if not await self._validator(req):
            raise ProviderError(code="authentication_failed", provider=self.provider, message="Stream connection was rejected.")

    def create_session(self, connection: MediaConnection, options: MediaSessionOptions | None = None) -> GenericJsonMediaSession:
        return GenericJsonMediaSession(connection, self.capabilities(), self._config, options)


class GenericJsonMediaSession(BaseMediaSession):
    def __init__(
        self,
        connection: MediaConnection,
        caps: ProviderCapabilities,
        config: GenericJsonConfig,
        options: MediaSessionOptions | None = None,
    ) -> None:
        super().__init__(config.provider, connection, caps, (), options)
        self.event_field = config.event_field
        self._config = config

    def _handle(self, msg: JsonObject) -> None:
        c = self._config
        event = msg[self.event_field]
        if event == c.events["start"]:
            if self.state != "awaiting_start":
                raise self._error("protocol_violation", "Received a second start message.")
            self._begin(self._id_at(msg, c.paths["callId"]), self._id_at(msg, c.paths["sessionId"]), c.format)
            self._emit(self._event("stream_started", None, tracks=[c.default_track], format=c.format, bidirectional=False))
        elif event == c.events["media"]:
            self._require_active(event)
            parent, key = _split(c.paths["payload"])
            holder = _walk(msg, parent)
            if holder is None:
                raise self.reader.fail(f"{c.paths['payload']} is missing.")
            payload = self.reader.base64(holder, key, c.paths["payload"])
            validate_audio_payload(c.format, len(payload), self.max_payload_bytes, self.provider)
            if c.format.encoding == "pcm_s16le" and c.pcm_byte_order == "big":
                payload = swap_bytes16(payload)
            sequence = self._int_at(msg, c.paths["sequence"]) if c.paths.get("sequence") else None
            timestamp = self._int_at(msg, c.paths["timestamp"]) if c.paths.get("timestamp") else None
            assert self.call_id is not None and self.session_id is not None
            kind: TimestampKind = "none" if timestamp is None else c.timestamp_kind
            frame = AudioFrame(
                call_id=self.call_id,
                session_id=self.session_id,
                provider=self.provider,
                direction=self._track_at(msg),
                format=c.format,
                payload=payload,
                timestamp_kind=kind,
                timestamp_ms=timestamp,
                sequence_number=sequence,
            )
            self._emit(self._event("audio", sequence, frame=frame))
        elif c.events.get("stop") and event == c.events["stop"]:
            self._require_active(event)
            self._finish("provider_stop", None)
        else:
            self._ignore()

    async def send_audio(self, payload: bytes, fmt: AudioFormat) -> None:
        require_capability(self.capabilities(), "playback")

    async def send_mark(self, name: str) -> None:
        require_capability(self.capabilities(), "playback_marks")

    async def clear_playback(self) -> None:
        require_capability(self.capabilities(), "playback_interruption")

    async def send_dtmf(self, digits: str) -> None:
        require_capability(self.capabilities(), "dtmf_send")

    def _id_at(self, msg: JsonObject, path: str) -> str:
        parent, key = _split(path)
        holder = _walk(msg, parent)
        if holder is None:
            raise self.reader.fail(f"{path} is missing.")
        return self.reader.id(holder, key, path)

    def _int_at(self, msg: JsonObject, path: str) -> int | None:
        parent, key = _split(path)
        holder = _walk(msg, parent)
        return None if holder is None else self.reader.optional_int(holder, key, path)

    def _track_at(self, msg: JsonObject) -> MediaDirection:
        c = self._config
        path = c.paths.get("track")
        if not path:
            return c.default_track
        parent, key = _split(path)
        holder = _walk(msg, parent)
        value = None if holder is None else self.reader.optional_string(holder, key, path)
        if value is None:
            return c.default_track
        if value in c.track_values:
            return c.track_values[value]
        if value == "inbound":
            return "inbound"
        if value == "outbound":
            return "outbound"
        raise self.reader.fail(f'{path} has unknown track "{value}".')


# ---------------------------------------------------------------------------------------------
# Binary sessions (raw PCM, RTP)


class BinaryMediaSession:
    """Base for transports whose audio arrives as binary messages. Exported for provider adapters."""

    def __init__(
        self,
        provider: str,
        connection: MediaConnection,
        *,
        call_id: str,
        session_id: str,
        direction: MediaDirection = "inbound",
        max_queued_events: int = DEFAULT_MAX_QUEUED_EVENTS,
        max_payload_bytes: int = DEFAULT_MAX_PAYLOAD_BYTES,
        now: Callable[[], float] | None = None,
    ) -> None:
        if not call_id or not session_id:
            raise _invalid(provider, "call_id and session_id are required.")
        self.provider = provider
        self.call_id = call_id
        self.session_id = session_id
        self.state: MediaSessionState = "active"
        self.input_format: AudioFormat | None = None
        self._connection = connection
        self._direction = direction
        self._max_payload_bytes = max_payload_bytes
        self._now = now or (lambda: time.time() * 1000)
        self._queue: BoundedQueue[TelephonyEvent] = BoundedQueue(max_queued_events, "reject", provider)
        self._dropped = 0
        self._connection_closed = False

    @property
    def dropped_audio_frames(self) -> int:
        return self._dropped

    def events(self) -> AsyncIterator[TelephonyEvent]:
        return self._queue

    def capabilities(self) -> ProviderCapabilities:
        raise NotImplementedError

    async def send_mark(self, name: str) -> None:
        require_capability(self.capabilities(), "playback_marks")

    async def clear_playback(self) -> None:
        require_capability(self.capabilities(), "playback_interruption")

    async def send_dtmf(self, digits: str) -> None:
        require_capability(self.capabilities(), "dtmf_send")

    async def close(self, reason: str | None = None) -> None:
        if self.state == "active" and self.input_format is not None:
            try:
                self._queue.push(self._event("stream_stopped", None, reason="socket_closed"))
            except ProviderError:
                pass  # full queue: closing still ends iteration
        self.state = "closed"
        self._queue.close()
        if self._connection_closed:
            return
        self._connection_closed = True
        await self._connection.close(1000, reason)

    def _require_open(self) -> None:
        if self.state != "active":
            raise ProviderError(code="session_closed", provider=self.provider, message="The media session is closed.")

    def _start(
        self, fmt: AudioFormat, *, bidirectional: bool | None = None, custom_parameters: Mapping[str, str] | None = None
    ) -> None:
        self.input_format = fmt
        extra: dict[str, Any] = {} if custom_parameters is None else {"customParameters": dict(custom_parameters)}
        self._queue.push(
            self._event("stream_started", None, tracks=[self._direction], format=fmt, bidirectional=bidirectional, **extra)
        )

    def _emit_event(self, event: TelephonyEvent) -> None:
        """Control events are never dropped; a full queue raises buffer_overflow."""
        self._queue.push(event)

    def _event(self, type_: Any, seq: int | None, **data: Any) -> TelephonyEvent:
        return TelephonyEvent(type_, self.provider, self.call_id, self.session_id, self._now(), seq, data)

    def _emit_audio(self, frame: AudioFrame, seq: int | None) -> None:
        try:
            self._queue.push(self._event("audio", seq, frame=frame))
        except ProviderError as err:
            if err.code != "buffer_overflow":
                raise
            self._dropped += 1

    def _send_binary(self) -> Callable[[bytes], Awaitable[None]] | None:
        send = getattr(self._connection, "send_binary", None)
        return send if callable(send) else None


class RawPcmMediaSession(BinaryMediaSession):
    """A WebSocket whose binary messages are raw audio in one known format."""

    def __init__(
        self,
        connection: MediaConnection,
        *,
        call_id: str,
        session_id: str,
        format: AudioFormat,
        provider: str = "raw_pcm",
        byte_order: Literal["little", "big"] = "little",
        bidirectional: bool = False,
        on_text: Callable[[str], None] | None = None,
        direction: MediaDirection = "inbound",
        max_queued_events: int = DEFAULT_MAX_QUEUED_EVENTS,
        max_payload_bytes: int = DEFAULT_MAX_PAYLOAD_BYTES,
        now: Callable[[], float] | None = None,
    ) -> None:
        super().__init__(
            provider, connection, call_id=call_id, session_id=session_id, direction=direction,
            max_queued_events=max_queued_events, max_payload_bytes=max_payload_bytes, now=now,
        )
        self._format = format
        self._byte_order = byte_order
        self._playable = bidirectional and self._send_binary() is not None
        self._on_text = on_text
        self._samples = 0
        self._chunks = 0
        self.ignored_messages = 0
        self._start(format)

    def capabilities(self) -> ProviderCapabilities:
        playback = (
            CapabilityEntry("supported")
            if self._playable
            else CapabilityEntry("requires_configuration", "Pass bidirectional=True and a connection with send_binary.")
        )
        return _capabilities(
            self.provider,
            {"live_inbound_audio": CapabilityEntry("supported"), "playback": playback, "bidirectional_audio": playback},
        )

    def receive(self, message: str | bytes) -> None:
        self._require_open()
        if isinstance(message, str):
            if self._on_text is not None:
                self._on_text(message)
            else:
                self.ignored_messages += 1
            return
        validate_audio_payload(self._format, len(message), self._max_payload_bytes, self.provider)
        payload = swap_bytes16(message) if self._format.encoding == "pcm_s16le" and self._byte_order == "big" else bytes(message)
        timestamp = self._samples * 1000 / self._format.sample_rate
        self._samples += len(payload) // bytes_per_sample(self._format)
        frame = AudioFrame(
            call_id=self.call_id, session_id=self.session_id, provider=self.provider, direction=self._direction,
            format=self._format, payload=payload, timestamp_kind="stream_relative_ms", timestamp_ms=timestamp,
            chunk=self._chunks,
        )
        self._chunks += 1
        self._emit_audio(frame, None)

    async def send_audio(self, payload: bytes, fmt: AudioFormat) -> None:
        require_capability(self.capabilities(), "playback")
        self._require_open()
        if fmt != self._format:
            raise ProviderError(code="unsupported_format", provider=self.provider, message="Playback must use the stream's format.")
        if not payload:
            raise _invalid(self.provider, "Cannot play an empty payload.")
        send = self._send_binary()
        assert send is not None
        await send(swap_bytes16(payload) if self._format.encoding == "pcm_s16le" and self._byte_order == "big" else payload)


# ---------------------------------------------------------------------------------------------
# RTP


@dataclass(frozen=True)
class RtpPacket:
    version: int
    padding: bool
    extension: bool
    csrc_count: int
    marker: bool
    payload_type: int
    sequence_number: int
    timestamp: int
    ssrc: int
    payload: bytes

    def to_wire(self) -> dict[str, Any]:
        return {
            "version": self.version, "padding": self.padding, "extension": self.extension, "csrcCount": self.csrc_count,
            "marker": self.marker, "payloadType": self.payload_type, "sequenceNumber": self.sequence_number,
            "timestamp": self.timestamp, "ssrc": self.ssrc, "payloadHex": self.payload.hex(),
        }


def parse_rtp_packet(data: bytes, provider: str = "rtp") -> RtpPacket:
    def fail(message: str) -> ProviderError:
        return ProviderError(code="malformed_message", provider=provider, message=message)

    if len(data) < 12:
        raise fail("RTP packet is shorter than its 12-byte header.")
    b0, b1 = data[0], data[1]
    version = b0 >> 6
    if version != 2:
        raise fail(f"RTP version {version} is not supported.")
    padding = bool(b0 & 0x20)
    extension = bool(b0 & 0x10)
    csrc_count = b0 & 0x0F
    offset = 12 + csrc_count * 4
    if offset > len(data):
        raise fail("RTP CSRC list runs past the packet.")
    if extension:
        if offset + 4 > len(data):
            raise fail("RTP header extension runs past the packet.")
        offset += 4 + struct.unpack_from(">H", data, offset + 2)[0] * 4
        if offset > len(data):
            raise fail("RTP header extension runs past the packet.")
    end = len(data)
    if padding:
        count = data[-1]
        if count == 0 or offset + count > end:
            raise fail("RTP padding is invalid.")
        end -= count
    seq, ts, ssrc = struct.unpack_from(">HII", data, 2)
    return RtpPacket(version, padding, extension, csrc_count, bool(b1 & 0x80), b1 & 0x7F, seq, ts, ssrc, bytes(data[offset:end]))


class RtpPacketizer:
    """Builds RTP packets (no CSRC, extension or padding). Sequence and timestamp wrap as RFC 3550 requires."""

    def __init__(self, *, payload_type: int, ssrc: int, initial_sequence: int = 0, initial_timestamp: int = 0) -> None:
        if not 0 <= payload_type <= 127:
            raise _invalid("rtp", "payload_type must be 0-127.")
        self._payload_type = payload_type
        self._ssrc = ssrc & 0xFFFFFFFF
        self._sequence = initial_sequence & 0xFFFF
        self._timestamp = initial_timestamp & 0xFFFFFFFF

    def packetize(self, payload: bytes, samples: int, marker: bool = False) -> bytes:
        header = struct.pack(">BBHII", 0x80, (0x80 if marker else 0) | self._payload_type, self._sequence, self._timestamp, self._ssrc)
        self._sequence = (self._sequence + 1) & 0xFFFF
        self._timestamp = (self._timestamp + samples) & 0xFFFFFFFF
        return header + payload


@dataclass(frozen=True)
class RtpPayloadFormat:
    format: AudioFormat
    #: RTP L16 is network byte order (big-endian) per RFC 3551.
    byte_order: Literal["little", "big"] = "little"


_PCMU = RtpPayloadFormat(AudioFormat("mulaw", 8000, 1))


class RtpMediaSession(BinaryMediaSession):
    """RTP media from a gateway. The host owns the UDP socket and passes each datagram to receive()."""

    def __init__(
        self,
        connection: MediaConnection,
        *,
        call_id: str,
        session_id: str,
        payload_types: Mapping[int, RtpPayloadFormat] | None = None,
        playback: tuple[int, int] | None = None,
        provider: str = "rtp",
        direction: MediaDirection = "inbound",
        max_queued_events: int = DEFAULT_MAX_QUEUED_EVENTS,
        max_payload_bytes: int = DEFAULT_MAX_PAYLOAD_BYTES,
        now: Callable[[], float] | None = None,
    ) -> None:
        """``playback`` is (payload_type, ssrc); it enables send_audio when the connection has send_binary."""
        super().__init__(
            provider, connection, call_id=call_id, session_id=session_id, direction=direction,
            max_queued_events=max_queued_events, max_payload_bytes=max_payload_bytes, now=now,
        )
        self._payload_types = dict(payload_types) if payload_types is not None else {0: _PCMU}
        self._playback = playback
        if playback is not None and playback[0] not in self._payload_types:
            raise _invalid(provider, f"Playback payload type {playback[0]} is not configured.")
        self._packetizer = (
            RtpPacketizer(payload_type=playback[0], ssrc=playback[1])
            if playback is not None and self._send_binary() is not None
            else None
        )
        self._ssrc: int | None = None
        self._last_sequence = 0
        self._first_timestamp = 0
        self._packets = 0
        self._lost = 0
        self._late = 0
        self._ssrc_changes = 0

    @property
    def stats(self) -> dict[str, int]:
        """Packets missing from the sequence (gaps), late or duplicate packets dropped, and SSRC switches."""
        return {"packets": self._packets, "lostPackets": self._lost, "latePackets": self._late, "ssrcChanges": self._ssrc_changes}

    def capabilities(self) -> ProviderCapabilities:
        playback = (
            CapabilityEntry("supported")
            if self._packetizer is not None
            else CapabilityEntry("requires_configuration", "Pass playback=(payload_type, ssrc) and a connection with send_binary.")
        )
        return _capabilities(
            self.provider,
            {"live_inbound_audio": CapabilityEntry("supported"), "playback": playback, "bidirectional_audio": playback},
        )

    def receive(self, message: str | bytes) -> None:
        self._require_open()
        if isinstance(message, str):
            raise ProviderError(code="malformed_message", provider=self.provider, message="RTP packets are binary.")
        packet = parse_rtp_packet(message, self.provider)
        mapping = self._payload_types.get(packet.payload_type)
        if mapping is None:
            raise ProviderError(
                code="unsupported_format", provider=self.provider, message=f"RTP payload type {packet.payload_type} is not configured."
            )
        if self.input_format is not None and mapping.format != self.input_format:
            raise ProviderError(code="protocol_violation", provider=self.provider, message="RTP payload format changed mid-stream.")
        if self._ssrc != packet.ssrc:
            if self._ssrc is not None:
                self._ssrc_changes += 1
            self._ssrc = packet.ssrc
            self._last_sequence = (packet.sequence_number - 1) & 0xFFFF
            if self.input_format is None:
                self._first_timestamp = packet.timestamp
        delta = (packet.sequence_number - self._last_sequence) & 0xFFFF
        if delta == 0 or delta > 0x8000:
            self._late += 1
            return
        self._lost += delta - 1
        self._last_sequence = packet.sequence_number
        validate_audio_payload(mapping.format, len(packet.payload), self._max_payload_bytes, self.provider)
        if self.input_format is None:
            self._start(mapping.format)
        payload = swap_bytes16(packet.payload) if mapping.format.encoding == "pcm_s16le" and mapping.byte_order == "big" else packet.payload
        elapsed = (packet.timestamp - self._first_timestamp) & 0xFFFFFFFF
        frame = AudioFrame(
            call_id=self.call_id, session_id=self.session_id, provider=self.provider, direction=self._direction,
            format=mapping.format, payload=payload, timestamp_kind="stream_relative_ms",
            timestamp_ms=elapsed * 1000 / mapping.format.sample_rate, sequence_number=packet.sequence_number,
            chunk=self._packets,
        )
        self._packets += 1
        self._emit_audio(frame, packet.sequence_number)

    async def send_audio(self, payload: bytes, fmt: AudioFormat) -> None:
        require_capability(self.capabilities(), "playback")
        self._require_open()
        assert self._playback is not None and self._packetizer is not None
        mapping = self._payload_types[self._playback[0]]
        if fmt != mapping.format:
            raise ProviderError(code="unsupported_format", provider=self.provider, message="Playback must use the configured payload format.")
        if not payload:
            raise _invalid(self.provider, "Cannot play an empty payload.")
        wire = swap_bytes16(payload) if fmt.encoding == "pcm_s16le" and mapping.byte_order == "big" else payload
        send = self._send_binary()
        assert send is not None
        await send(self._packetizer.packetize(wire, len(payload) // bytes_per_sample(fmt)))


# ---------------------------------------------------------------------------------------------
# WAV (batch / recordings)


@dataclass(frozen=True)
class WavAudio:
    format: AudioFormat
    data: bytes


def read_wav(data: bytes) -> WavAudio:
    """Read PCM16, mu-law or A-law WAV. Unknown chunks are skipped; oversized data sizes are clamped."""

    def fail(code: Literal["malformed_message", "unsupported_format"], message: str) -> ProviderError:
        return ProviderError(code=code, provider="wav", message=message)

    if len(data) < 12 or data[0:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise fail("malformed_message", "Not a RIFF/WAVE file.")
    fmt: AudioFormat | None = None
    offset = 12
    while offset + 8 <= len(data):
        chunk_id = data[offset : offset + 4]
        size = struct.unpack_from("<I", data, offset + 4)[0]
        body = offset + 8
        if chunk_id == b"fmt ":
            if size < 16 or body + 16 > len(data):
                raise fail("malformed_message", "fmt chunk is truncated.")
            tag, channels, sample_rate = struct.unpack_from("<HHI", data, body)
            bits = struct.unpack_from("<H", data, body + 14)[0]
            if tag == 0xFFFE and size >= 40 and body + 26 <= len(data):
                tag = struct.unpack_from("<H", data, body + 24)[0]
            encoding: Literal["pcm_s16le", "mulaw", "alaw"] | None = (
                "pcm_s16le" if tag == 1 and bits == 16 else "mulaw" if tag == 7 and bits == 8 else "alaw" if tag == 6 and bits == 8 else None
            )
            if encoding is None:
                raise fail("unsupported_format", f"WAV format tag {tag} with {bits}-bit samples is not supported.")
            if not 1 <= channels <= 2:
                raise fail("unsupported_format", f"{channels}-channel WAV is not supported.")
            fmt = AudioFormat(encoding, sample_rate, channels)
        elif chunk_id == b"data":
            if fmt is None:
                raise fail("malformed_message", "data chunk appears before fmt.")
            return WavAudio(fmt, bytes(data[body : min(body + size, len(data))]))
        offset = body + size + (size & 1)
    raise fail("malformed_message", "WAV file has no data chunk.")


def write_wav_pcm16(pcm: bytes, sample_rate: int, channels: int = 1) -> bytes:
    """Write a 16-bit PCM WAV (for examples, fixtures and exporting processed audio)."""
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF", 36 + len(pcm), b"WAVE", b"fmt ", 16, 1, channels, sample_rate, sample_rate * channels * 2,
        channels * 2, 16, b"data", len(pcm),
    )
    return header + pcm


def file_frames(
    wav: WavAudio,
    *,
    call_id: str,
    session_id: str,
    provider: str = "file",
    frame_ms: int = 20,
    direction: MediaDirection = "inbound",
) -> list[AudioFrame]:
    """Split a recording into fixed frames that enter the same AudioPipeline as live audio."""
    numerator = wav.format.sample_rate * frame_ms * bytes_per_sample(wav.format)
    if numerator % 1000 or numerator <= 0:
        raise _invalid("file", f"frame_ms {frame_ms} does not divide the sample rate.")
    per_frame = numerator // 1000
    frames = []
    for i, at in enumerate(range(0, len(wav.data), per_frame)):
        payload = wav.data[at : at + per_frame]
        frames.append(
            AudioFrame(
                call_id=call_id, session_id=session_id, provider=provider, direction=direction, format=wav.format,
                payload=payload, timestamp_kind="stream_relative_ms", timestamp_ms=i * frame_ms, chunk=i,
                is_complete_frame=len(payload) == per_frame,
            )
        )
    return frames
