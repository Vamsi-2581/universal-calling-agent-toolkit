# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Vasik Mansuri
"""Telnyx media streaming (WebSocket).

Protocol: https://developers.telnyx.com/docs/voice/programmable-voice/media-streaming
Telnyx does not document the unit of media.timestamp, so frames are ordered by chunk and carry no timestamp.
Call control (Telnyx Call Control API) is not implemented: register Telnyx with call_control=None.
"""

from __future__ import annotations

import base64
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Any, Literal

from ..adapters import MediaConnection, StreamConnectionRequest
from ..audio import swap_bytes16, validate_audio_payload
from ..capabilities import require_capability
from ..errors import ProviderError, ProviderErrorCode
from ..media_session import BaseMediaSession, MediaSessionOptions
from ..parse import DTMF_DIGIT, JsonObject
from ..types import (
    CAPABILITIES,
    SUPPORTED_SAMPLE_RATES,
    AudioEncoding,
    AudioFormat,
    AudioFrame,
    Capability,
    CapabilityEntry,
    MediaDirection,
    ProviderCapabilities,
)

TELNYX = "telnyx"
_ADAPTER_VERSION = "0.1.0"
_ERROR_CODES: dict[str, ProviderErrorCode] = {
    "100002": "unknown",
    "100003": "malformed_message",
    "100004": "unsupported_format",
    "100005": "rate_limited",
}
_BIDIRECTIONAL_DEPENDENT: tuple[Capability, ...] = ("bidirectional_audio", "playback", "playback_marks", "playback_interruption")
_NEEDS_RTP_MODE = CapabilityEntry(
    "requires_configuration",
    "Start the stream with stream_bidirectional_mode=rtp and pass bidirectional=True when creating the session.",
)


def _media_capabilities(has_validator: bool) -> ProviderCapabilities:
    caps: dict[Capability, CapabilityEntry] = {
        c: CapabilityEntry("unsupported", "Call-control capability; the Telnyx Call Control API is not implemented.")
        for c in CAPABILITIES
    }
    caps.update(
        {
            "live_inbound_audio": CapabilityEntry("supported"),
            "live_outbound_audio": CapabilityEntry("supported", "Set stream_track to outbound_track or both_tracks."),
            "separate_tracks": CapabilityEntry("supported"),
            "dtmf_receive": CapabilityEntry("supported"),
            "dtmf_send": CapabilityEntry(
                "unavailable_from_provider", "The media stream has no DTMF message; use Call Control send_dtmf."
            ),
            "bidirectional_audio": _NEEDS_RTP_MODE,
            "playback": _NEEDS_RTP_MODE,
            "playback_marks": _NEEDS_RTP_MODE,
            "playback_interruption": _NEEDS_RTP_MODE,
            "stream_auth_validation": CapabilityEntry("supported", "Uses the host-supplied connection_validator.")
            if has_validator
            else CapabilityEntry(
                "requires_configuration",
                "Telnyx's streaming docs do not describe a handshake signature. Pass connection_validator.",
            ),
            "provider_noise_suppression": CapabilityEntry("unsupported", "Not reviewed for this adapter."),
            "stream_recovery": CapabilityEntry("unsupported", "Not documented by Telnyx."),
        }
    )
    return ProviderCapabilities(provider=TELNYX, adapter_version=_ADAPTER_VERSION, capabilities=caps)


@dataclass(frozen=True)
class TelnyxSessionOptions(MediaSessionOptions):
    #: Tracks requested with stream_track; the start message does not list them.
    tracks: Sequence[MediaDirection] = ("inbound",)
    #: Byte order of L16 payloads; Telnyx does not document it, so L16 is refused until set.
    l16_byte_order: Literal["little", "big"] | None = None


class TelnyxMediaTransport:
    provider = TELNYX

    def __init__(
        self, *, connection_validator: Callable[[StreamConnectionRequest], Awaitable[bool]] | None = None
    ) -> None:
        self._validator = connection_validator

    def capabilities(self) -> ProviderCapabilities:
        return _media_capabilities(self._validator is not None)

    async def validate_connection(self, req: StreamConnectionRequest) -> None:
        require_capability(self.capabilities(), "stream_auth_validation")
        assert self._validator is not None
        if not await self._validator(req):
            raise ProviderError(code="authentication_failed", provider=TELNYX, message="Stream connection was rejected.")

    def create_session(self, connection: MediaConnection, options: MediaSessionOptions | None = None) -> TelnyxMediaSession:
        return TelnyxMediaSession(connection, self.capabilities(), options)


class TelnyxMediaSession(BaseMediaSession):
    def __init__(
        self, connection: MediaConnection, capabilities: ProviderCapabilities, options: MediaSessionOptions | None = None
    ) -> None:
        super().__init__(TELNYX, connection, capabilities, _BIDIRECTIONAL_DEPENDENT, options)
        telnyx = options if isinstance(options, TelnyxSessionOptions) else TelnyxSessionOptions()
        self._tracks = list(telnyx.tracks)
        self._l16_byte_order = telnyx.l16_byte_order

    def _handle(self, msg: JsonObject) -> None:
        r = self.reader
        event = msg["event"]
        if event == "connected":
            if self.state != "awaiting_start":
                raise self._error("protocol_violation", "connected arrived after start.")
        elif event == "start":
            if self.state != "awaiting_start":
                raise self._error("protocol_violation", "Received a second start message.")
            seq = r.optional_int(msg, "sequence_number")
            stream_id = r.id(msg, "stream_id")
            start = r.object(msg, "start")
            call_id = r.id(start, "call_control_id", "start.call_control_id")
            mf = r.object(start, "media_format", "start.media_format")
            fmt = self._format(
                r.string(mf, "encoding", "start.media_format.encoding"),
                r.int(mf, "sample_rate", "start.media_format.sample_rate"),
                r.optional_int(mf, "channels", "start.media_format.channels") or 1,
            )
            custom = {}
            for key, name in (("from", "from"), ("to", "to"), ("client_state", "clientState")):
                value = r.optional_string(start, key, f"start.{key}")
                if value is not None:
                    custom[name] = value
            self._begin(call_id, stream_id, fmt)
            data: dict[str, Any] = {"tracks": list(self._tracks), "format": fmt, "bidirectional": self.bidirectional}
            if custom:
                data["customParameters"] = custom
            self._emit(self._event("stream_started", seq, **data))
        elif event == "media":
            self._require_active(event)
            self._require_same_stream(r.optional_string(msg, "stream_id"))
            seq = r.optional_int(msg, "sequence_number")
            media = r.object(msg, "media")
            track = r.string(media, "track", "media.track")
            if track not in ("inbound", "outbound"):
                raise r.fail(f'media.track has unknown track "{track}".')
            chunk = r.optional_int(media, "chunk", "media.chunk")
            payload = r.base64(media, "payload", "media.payload")
            assert self.input_format is not None and self.call_id is not None and self.session_id is not None
            validate_audio_payload(self.input_format, len(payload), self.max_payload_bytes, TELNYX)
            if self.input_format.encoding == "pcm_s16le" and self._l16_byte_order == "big":
                payload = swap_bytes16(payload)
            frame = AudioFrame(
                call_id=self.call_id, session_id=self.session_id, provider=TELNYX,
                direction="inbound" if track == "inbound" else "outbound", format=self.input_format, payload=payload,
                timestamp_kind="none", timestamp_ms=None, sequence_number=seq, chunk=chunk,
            )
            self._emit(self._event("audio", seq, frame=frame))
        elif event == "dtmf":
            self._require_active(event)
            self._require_same_stream(r.optional_string(msg, "stream_id"))
            seq = r.optional_int(msg, "sequence_number")
            digit = r.string(r.object(msg, "dtmf"), "digit", "dtmf.digit")
            if not DTMF_DIGIT.match(digit):
                raise r.fail("dtmf.digit must be a single DTMF character.")
            self._emit(self._event("dtmf", seq, digit=digit, direction="inbound"))
        elif event == "mark":
            self._require_active(event)
            self._require_same_stream(r.optional_string(msg, "stream_id"))
            name = r.string(r.object(msg, "mark"), "name", "mark.name")
            self._emit(self._event("playback_mark", r.optional_int(msg, "sequence_number"), name=name))
        elif event == "error":
            payload_obj = r.object(msg, "payload")
            raw = payload_obj.get("code")
            provider_code = str(raw) if isinstance(raw, (int, str)) and not isinstance(raw, bool) else "unknown"
            title = r.optional_string(payload_obj, "title", "payload.title") or "error"
            error = ProviderError(
                code=_ERROR_CODES.get(provider_code, "unknown"),
                provider=TELNYX,
                message=f"Telnyx stream error {provider_code}: {title}",
                provider_code=provider_code,
                call_id=self.call_id,
                session_id=self.session_id,
            )
            if self.state != "active":
                raise error
            self._emit(self._event("error", None, error=error.to_dict()))
        elif event == "stop":
            self._require_active(event)
            self._require_same_stream(r.optional_string(msg, "stream_id"))
            self._finish("provider_stop", r.optional_int(msg, "sequence_number"))
        else:
            self._ignore()

    async def send_audio(self, payload: bytes, fmt: AudioFormat) -> None:
        require_capability(self.capabilities(), "playback")
        if fmt != self.input_format:
            raise ProviderError(
                code="unsupported_format",
                provider=TELNYX,
                capability="playback",
                message="Playback must match the stream's codec (stream_bidirectional_codec).",
            )
        if not payload:
            raise self._invalid("Cannot play an empty payload.", "playback")
        wire = swap_bytes16(payload) if fmt.encoding == "pcm_s16le" and self._l16_byte_order == "big" else payload
        await self._send_json("playback", {"event": "media", "media": {"payload": base64.b64encode(wire).decode()}})

    async def send_mark(self, name: str) -> None:
        require_capability(self.capabilities(), "playback_marks")
        if not name:
            raise self._invalid("Mark name must not be empty.", "playback_marks")
        await self._send_json("playback_marks", {"event": "mark", "mark": {"name": name}})

    async def clear_playback(self) -> None:
        await self._send_json("playback_interruption", {"event": "clear"})

    async def send_dtmf(self, digits: str) -> None:
        require_capability(self.capabilities(), "dtmf_send")

    def _format(self, encoding: str, sample_rate: int, channels: int) -> AudioFormat:
        mapped: AudioEncoding
        if encoding == "PCMU":
            mapped = "mulaw"
        elif encoding == "PCMA":
            mapped = "alaw"
        elif encoding == "L16":
            if self._l16_byte_order is None:
                raise self._invalid(
                    "Telnyx does not document the byte order of L16 streams. Verify it and pass l16_byte_order, or use PCMU."
                )
            mapped = "pcm_s16le"
        else:
            raise ProviderError(code="unsupported_format", provider=TELNYX, message=f"Unsupported Telnyx encoding {encoding}.")
        if sample_rate not in SUPPORTED_SAMPLE_RATES:
            raise ProviderError(code="unsupported_format", provider=TELNYX, message=f"Unsupported sample rate {sample_rate} Hz.")
        return AudioFormat(mapped, sample_rate, channels)
