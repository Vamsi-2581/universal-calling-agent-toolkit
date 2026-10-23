# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Vasik Mansuri
"""Plivo adapters.

Audio Streams: https://www.plivo.com/docs/voice/api/audio-streams
Event protocol: https://www.plivo.com/docs/voice-agents/audio-streaming/concepts/stream-event-protocol
Signature V3 mirrors plivo-python plivo/utils/signature_v3.py.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import parse_qs, quote

from ..adapters import (
    BaseCallControlAdapter,
    MediaConnection,
    MediaStreamHandle,
    MediaStreamRequest,
    OutboundCallRequest,
    SecretResolver,
    StreamConnectionRequest,
    TransferTarget,
    WebhookRequest,
)
from ..audio import swap_bytes16, validate_audio_payload
from ..capabilities import require_capability
from ..errors import ProviderError
from ..http import HttpClient, HttpRequest, HttpResponse, basic_auth, call_api, json_body, urllib_http_client
from ..media_session import BaseMediaSession, MediaSessionOptions
from ..parse import DTMF_DIGIT, JsonObject, get_header
from ..types import (
    SUPPORTED_SAMPLE_RATES,
    AdapterHealth,
    AudioEncoding,
    AudioFormat,
    AudioFrame,
    CallSession,
    CallStatus,
    Capability,
    CapabilityEntry,
    MediaDirection,
    ProviderCapabilities,
    TelephonyEvent,
)

PLIVO = "plivo"
_ADAPTER_VERSION = "0.1.0"
#: playAudio accepts these rates per the Audio Streams API page.
_PLAYBACK_RATES = (8000, 16000)

# ---------------------------------------------------------------------------------------------
# Signature V3

Params = Mapping[str, Sequence[str]]


def _split_url(url: str) -> tuple[str, str]:
    base, _, query = url.split("#", 1)[0].partition("?")
    return base, query


def _sorted_query(params: Params) -> str:
    return "&".join("&".join(f"{k}={v}" for v in sorted(params[k])) for k in sorted(params))


def _sorted_params(params: Params) -> str:
    return "".join("".join(k + v for v in sorted(params[k])) for k in sorted(params))


def _base_url(url: str, params: Params, empty_post_params: bool) -> str:
    base, query = _split_url(url)
    merged: dict[str, Sequence[str]] = dict(params)
    merged.update(parse_qs(query, keep_blank_values=True))
    q = _sorted_query(merged)
    out = base
    if q or not empty_post_params:
        out += "?" + q
    if q and not empty_post_params:
        out += "."
    return out


def compute_plivo_signature_v3(
    auth_token: str, method: str, url: str, nonce: str, params: Params | None = None
) -> str:
    params = params or {}
    if method.upper() == "GET":
        base = _base_url(url, params, True)
    else:
        base = _base_url(url, {}, not params) + _sorted_params(params)
    digest = hmac.new(auth_token.encode(), f"{base}.{nonce}".encode(), hashlib.sha256).digest()
    return base64.b64encode(digest).decode()


def validate_plivo_request(auth_token: str, req: WebhookRequest) -> bool:
    """Validate X-Plivo-Signature-V3 (comma-separated list allowed). Returns False rather than raising."""
    header = get_header(req.headers, "x-plivo-signature-v3")
    nonce = get_header(req.headers, "x-plivo-signature-v3-nonce")
    if not header or not nonce:
        return False
    is_form = (get_header(req.headers, "content-type") or "").lower().startswith("application/x-www-form-urlencoded")
    params = parse_qs(req.raw_body, keep_blank_values=True) if req.method.upper() == "POST" and is_form else {}
    expected = compute_plivo_signature_v3(auth_token, req.method, req.url, nonce, params)
    return any(hmac.compare_digest(candidate, expected) for candidate in header.split(","))


# ---------------------------------------------------------------------------------------------
# Capabilities

_CALL_CONTROL_ONLY: tuple[Capability, ...] = (
    "inbound_calls",
    "outbound_calls",
    "answer_call",
    "end_call",
    "call_transfer",
    "call_status_events",
    "media_stream_control",
    "recording_access",
    "webhook_validation",
)
_MEDIA_ONLY: tuple[Capability, ...] = (
    "dtmf_receive",
    "live_inbound_audio",
    "live_outbound_audio",
    "bidirectional_audio",
    "separate_tracks",
    "playback",
    "playback_marks",
    "playback_interruption",
    "stream_auth_validation",
    "provider_noise_suppression",
    "stream_recovery",
)
_BIDIRECTIONAL_DEPENDENT: tuple[Capability, ...] = (
    "bidirectional_audio",
    "playback",
    "playback_marks",
    "playback_interruption",
    "dtmf_send",
)
_NEEDS_BIDIRECTIONAL = CapabilityEntry(
    "requires_configuration",
    "Start the stream with bidirectional=true (inbound track only) and pass bidirectional=True when creating the session.",
)


def _media_capabilities(has_validator: bool) -> ProviderCapabilities:
    mulaw = AudioFormat("mulaw", 8000, 1)
    l16 = tuple(AudioFormat("pcm_s16le", rate, 1) for rate in (8000, 16000, 24000))
    caps: dict[Capability, CapabilityEntry] = {
        c: CapabilityEntry("unsupported", "Call-control capability; see PlivoCallControl.") for c in _CALL_CONTROL_ONLY
    }
    caps.update(
        {
            "dtmf_receive": CapabilityEntry("supported"),
            "live_inbound_audio": CapabilityEntry("supported"),
            "live_outbound_audio": CapabilityEntry(
                "supported", "audio_track=outbound or both; unidirectional streams only."
            ),
            "separate_tracks": CapabilityEntry("supported"),
            "bidirectional_audio": _NEEDS_BIDIRECTIONAL,
            "playback": _NEEDS_BIDIRECTIONAL,
            "playback_marks": _NEEDS_BIDIRECTIONAL,
            "playback_interruption": _NEEDS_BIDIRECTIONAL,
            "dtmf_send": _NEEDS_BIDIRECTIONAL,
            "stream_auth_validation": CapabilityEntry("supported", "Uses the host-supplied connection_validator.")
            if has_validator
            else CapabilityEntry(
                "requires_configuration",
                "Plivo does not document a signed WebSocket handshake. Pass connection_validator, "
                "e.g. to check a secret you put in the stream URL.",
            ),
            "provider_noise_suppression": CapabilityEntry(
                "requires_configuration",
                "Set noise_cancellation when starting the stream. This is Plivo's own processing, "
                "separate from the toolkit's audio pipeline.",
            ),
            "stream_recovery": CapabilityEntry("unsupported", "Plivo does not document resuming a stream after disconnect."),
        }
    )
    return ProviderCapabilities(
        provider=PLIVO,
        adapter_version=_ADAPTER_VERSION,
        capabilities=caps,
        supported_input_formats=(mulaw, *l16),
        supported_playback_formats=(mulaw, *(f for f in l16 if f.sample_rate in _PLAYBACK_RATES)),
    )


def _call_control_capabilities() -> ProviderCapabilities:
    media = CapabilityEntry("unsupported", "Media capability; see PlivoMediaTransport.")
    caps: dict[Capability, CapabilityEntry] = {c: media for c in _MEDIA_ONLY}
    caps.update(
        {
            "inbound_calls": CapabilityEntry(
                "supported", "Plivo requests your answer_url; respond with Plivo XML. parse_webhook normalizes callbacks."
            ),
            "outbound_calls": CapabilityEntry("supported", "callId is Plivo's request_uuid; the call_uuid arrives in callbacks."),
            "answer_call": CapabilityEntry("unavailable_from_provider", "Calls are answered by returning XML from your answer_url."),
            "end_call": CapabilityEntry("supported"),
            "call_transfer": CapabilityEntry("supported", "Target is an https URL returning Plivo XML (A leg)."),
            "call_status_events": CapabilityEntry("supported"),
            "media_stream_control": CapabilityEntry("supported", "Audio Stream API, including provider-native noise_cancellation."),
            "recording_access": CapabilityEntry("unsupported", "Not implemented yet."),
            "dtmf_send": CapabilityEntry("supported"),
            "webhook_validation": CapabilityEntry("supported", "X-Plivo-Signature-V3 with nonce."),
        }
    )
    return ProviderCapabilities(provider=PLIVO, adapter_version=_ADAPTER_VERSION, capabilities=caps)


# ---------------------------------------------------------------------------------------------
# Adapters

_PLIVO_STATUS: dict[str, CallStatus] = {
    "queued": "queued",
    "ringing": "ringing",
    "in-progress": "in_progress",
    "completed": "completed",
    "busy": "busy",
    "failed": "failed",
    "timeout": "no_answer",
    "no-answer": "no_answer",
    "cancel": "canceled",
}
_STREAM_OPTIONS = frozenset(
    {"stream_timeout", "status_callback_url", "status_callback_method", "extra_headers", "noise_cancellation", "noise_cancellation_level"}
)


def _invalid(message: str) -> ProviderError:
    return ProviderError(code="invalid_configuration", provider=PLIVO, message=message)


def _seg(value: str) -> str:
    return quote(value, safe="")


def _content_type(fmt: AudioFormat) -> str:
    if fmt.encoding == "mulaw" and fmt.sample_rate == 8000:
        return "audio/x-mulaw;rate=8000"
    if fmt.encoding == "pcm_s16le" and fmt.sample_rate in (8000, 16000, 24000):
        return f"audio/x-l16;rate={fmt.sample_rate}"
    raise ProviderError(
        code="unsupported_format", provider=PLIVO, message=f"Plivo streams do not offer {fmt.encoding} at {fmt.sample_rate} Hz."
    )


class PlivoCallControl(BaseCallControlAdapter):
    """Plivo REST call control (Call, DTMF and Audio Stream APIs) plus webhook validation and parsing."""

    provider = PLIVO

    def __init__(
        self,
        *,
        auth_id: str,
        auth_token: SecretResolver,
        http: HttpClient | None = None,
        base_url: str = "https://api.plivo.com",
        timeout_s: float = 10.0,
        now: Callable[[], float] | None = None,
    ) -> None:
        if not auth_id:
            raise _invalid("auth_id is required.")
        self._auth_id = auth_id
        self._auth_token = auth_token
        self._http: HttpClient = http or urllib_http_client
        self._base_url = base_url.rstrip("/")
        self._timeout_s = timeout_s
        self._now = now or (lambda: time.time() * 1000)

    def capabilities(self) -> ProviderCapabilities:
        return _call_control_capabilities()

    async def validate_webhook(self, req: WebhookRequest) -> None:
        if not validate_plivo_request(await self._auth_token(), req):
            raise ProviderError(code="signature_invalid", provider=PLIVO, message="X-Plivo-Signature-V3 did not match.")

    async def parse_webhook(self, req: WebhookRequest) -> list[TelephonyEvent]:
        """Parse a call callback. Call validate_webhook first; this method does not authenticate."""
        form = parse_qs(req.raw_body, keep_blank_values=True)
        call_id = (form.get("CallUUID") or [""])[0]
        status = (form.get("CallStatus") or [""])[0]
        if not call_id or not status:
            raise ProviderError(code="malformed_message", provider=PLIVO, message="Callback needs CallUUID and CallStatus.")
        return [
            TelephonyEvent(
                type="call_status",
                provider=PLIVO,
                call_id=call_id,
                session_id=call_id,
                received_at_ms=self._now(),
                provider_sequence=None,
                data={"status": _PLIVO_STATUS.get(status, "unknown"), "providerStatus": status},
            )
        ]

    async def start_outbound_call(self, req: OutboundCallRequest) -> CallSession:
        require_capability(self.capabilities(), "outbound_calls")
        if not req.to or not req.from_:
            raise _invalid("to and from are required.")
        a = req.answer
        if not isinstance(a.get("url"), str):
            raise _invalid("answer.url (Plivo answer_url) is required.")
        body: dict[str, Any] = {"from": req.from_, "to": req.to, "answer_url": a["url"]}
        if isinstance(a.get("method"), str):
            body["answer_method"] = a["method"]
        if isinstance(a.get("hangupUrl"), str):
            body["hangup_url"] = a["hangupUrl"]
        res = json_body(PLIVO, await self._request("POST", "/Call/", body))
        if not isinstance(res.get("request_uuid"), str):
            raise self._unexpected("request_uuid")
        return CallSession(res["request_uuid"], PLIVO, "outbound", "queued", from_=req.from_, to=req.to)

    async def end_call(self, call_id: str) -> None:
        require_capability(self.capabilities(), "end_call")
        await self._request("DELETE", f"/Call/{_seg(call_id)}/", None)

    async def transfer_call(self, call_id: str, target: TransferTarget) -> None:
        require_capability(self.capabilities(), "call_transfer")
        if not target.to.startswith("https://"):
            raise _invalid("Plivo transfers to an https URL that returns Plivo XML.")
        await self._request("POST", f"/Call/{_seg(call_id)}/", {"legs": "aleg", "aleg_url": target.to})

    async def send_dtmf(self, call_id: str, digits: str) -> None:
        require_capability(self.capabilities(), "dtmf_send")
        if not re.fullmatch(r"[0-9*#A-Da-d]+", digits):
            raise _invalid(f'"{digits}" is not a DTMF digit string.')
        await self._request("POST", f"/Call/{_seg(call_id)}/DTMF/", {"digits": digits})

    async def start_media_stream(self, call_id: str, req: MediaStreamRequest) -> MediaStreamHandle:
        require_capability(self.capabilities(), "media_stream_control")
        if not req.url.startswith("wss://"):
            raise _invalid("Stream url must start with wss://.")
        tracks = list(dict.fromkeys(req.tracks))
        if not tracks or any(t not in ("inbound", "outbound") for t in tracks):
            raise _invalid("tracks must be inbound and/or outbound.")
        audio_track = "both" if len(tracks) == 2 else tracks[0]
        if req.bidirectional and audio_track != "inbound":
            raise _invalid('Plivo bidirectional streams require tracks: ["inbound"].')
        body: dict[str, Any] = {"service_url": req.url, "bidirectional": req.bidirectional, "audio_track": audio_track}
        if req.format is not None:
            body["content_type"] = _content_type(req.format)
        for key, value in req.provider_options.items():
            if key not in _STREAM_OPTIONS:
                raise _invalid(f"Unknown Plivo stream option {key}.")
            if key == "noise_cancellation":
                if not isinstance(value, bool):
                    raise _invalid("noise_cancellation must be a boolean.")
                body[key] = "true" if value else "false"
            elif key == "noise_cancellation_level":
                if isinstance(value, bool) or not isinstance(value, int) or not 60 <= value <= 100:
                    raise _invalid("noise_cancellation_level must be an integer from 60 to 100.")
                body[key] = value
            else:
                body[key] = value
        res = json_body(PLIVO, await self._request("POST", f"/Call/{_seg(call_id)}/Stream/", body))
        if not isinstance(res.get("stream_id"), str):
            raise self._unexpected("stream_id")
        return MediaStreamHandle(call_id=call_id, stream_id=res["stream_id"])

    async def stop_media_stream(self, call_id: str, stream_id: str) -> None:
        require_capability(self.capabilities(), "media_stream_control")
        await self._request("DELETE", f"/Call/{_seg(call_id)}/Stream/{_seg(stream_id)}/", None)

    async def health(self) -> AdapterHealth:
        return AdapterHealth(PLIVO, "healthy", time.time() * 1000, detail="Configuration only; no remote probe.")

    async def _request(self, method: Literal["POST", "DELETE"], path: str, body: dict[str, Any] | None) -> HttpResponse:
        token = await self._auth_token()
        headers = {"Authorization": basic_auth(self._auth_id, token), "Accept": "application/json"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        request = HttpRequest(
            method=method,
            url=f"{self._base_url}/v1/Account/{_seg(self._auth_id)}{path}",
            headers=headers,
            body=None if body is None else json.dumps(body),
        )
        return await call_api(PLIVO, self._http, request, timeout_s=self._timeout_s)

    def _unexpected(self, field_name: str) -> ProviderError:
        return ProviderError(code="protocol_violation", provider=PLIVO, message=f"Plivo response is missing {field_name}.")


@dataclass(frozen=True)
class PlivoSessionOptions(MediaSessionOptions):
    #: Byte order of audio/x-l16 payloads. Plivo's docs do not state it, so L16 streams are refused
    #: until you verify it against your account and set it here.
    l16_byte_order: Literal["little", "big"] | None = None


class PlivoMediaTransport:
    provider = PLIVO

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
            raise ProviderError(code="authentication_failed", provider=PLIVO, message="Stream connection was rejected.")

    def create_session(
        self, connection: MediaConnection, options: MediaSessionOptions | None = None
    ) -> PlivoMediaSession:
        return PlivoMediaSession(connection, self.capabilities(), options)


class PlivoMediaSession(BaseMediaSession):
    def __init__(
        self, connection: MediaConnection, capabilities: ProviderCapabilities, options: MediaSessionOptions | None = None
    ) -> None:
        super().__init__(PLIVO, connection, capabilities, _BIDIRECTIONAL_DEPENDENT, options)
        self._l16_byte_order = options.l16_byte_order if isinstance(options, PlivoSessionOptions) else None

    def _handle(self, msg: JsonObject) -> None:
        r = self.reader
        event = msg["event"]
        if event == "start":
            if self.state != "awaiting_start":
                raise self._error("protocol_violation", "Received a second start message.")
            seq = r.optional_int(msg, "sequenceNumber")
            start = r.object(msg, "start")
            call_id = r.id(start, "callId", "start.callId")
            stream_id = r.id(start, "streamId", "start.streamId")
            tracks = [self._track(t, "start.tracks") for t in r.string_list(start, "tracks", "start.tracks")]
            mf = r.object(start, "mediaFormat", "start.mediaFormat")
            fmt = self._format(
                r.string(mf, "encoding", "start.mediaFormat.encoding"),
                r.int(mf, "sampleRate", "start.mediaFormat.sampleRate"),
                r.optional_int(mf, "channels", "start.mediaFormat.channels") or 1,
            )
            extra_headers = r.optional_string(msg, "extra_headers")
            self._begin(call_id, stream_id, fmt)
            data: dict[str, object] = {"tracks": tracks, "format": fmt, "bidirectional": self.bidirectional}
            if extra_headers:
                data["customParameters"] = {"extraHeaders": extra_headers}
            self._emit(self._event("stream_started", seq, **data))
        elif event == "media":
            self._require_active(event)
            self._require_same_stream(r.optional_string(msg, "streamId"))
            seq = r.optional_int(msg, "sequenceNumber")
            media = r.object(msg, "media")
            direction = self._track(r.string(media, "track", "media.track"), "media.track")
            timestamp = r.optional_int(media, "timestamp", "media.timestamp")
            chunk = r.optional_int(media, "chunk", "media.chunk")
            payload = r.base64(media, "payload", "media.payload")
            assert self.input_format is not None and self.call_id is not None and self.session_id is not None
            validate_audio_payload(self.input_format, len(payload), self.max_payload_bytes, PLIVO)
            if self.input_format.encoding == "pcm_s16le" and self._l16_byte_order == "big":
                payload = swap_bytes16(payload)
            frame = AudioFrame(
                call_id=self.call_id,
                session_id=self.session_id,
                provider=PLIVO,
                direction=direction,
                format=self.input_format,
                payload=payload,
                timestamp_kind="none" if timestamp is None else "unix_epoch_ms",
                timestamp_ms=timestamp,
                sequence_number=seq,
                chunk=chunk,
                is_complete_frame=False,
            )
            self._emit(self._event("audio", seq, frame=frame))
        elif event == "dtmf":
            self._require_active(event)
            self._require_same_stream(r.optional_string(msg, "streamId"))
            seq = r.optional_int(msg, "sequenceNumber")
            dtmf = r.object(msg, "dtmf")
            digit = r.string(dtmf, "digit", "dtmf.digit")
            if not DTMF_DIGIT.match(digit):
                raise r.fail("dtmf.digit must be a single DTMF character.")
            track = r.optional_string(dtmf, "track", "dtmf.track")
            extra = {} if track is None else {"direction": self._track(track, "dtmf.track")}
            self._emit(self._event("dtmf", seq, digit=digit, **extra))
        elif event == "playedStream":
            self._require_active(event)
            self._require_same_stream(r.optional_string(msg, "streamId"))
            self._emit(self._event("playback_mark", r.optional_int(msg, "sequenceNumber"), name=r.string(msg, "name")))
        elif event == "clearedAudio":
            self._require_active(event)
            self._require_same_stream(r.optional_string(msg, "streamId"))
            self._emit(self._event("playback_cleared", r.optional_int(msg, "sequenceNumber")))
        elif event == "stop":
            # Not in Plivo's WebSocket docs; handled defensively. Socket close is the documented end.
            self._require_active(event)
            self._require_same_stream(r.optional_string(msg, "streamId"))
            self._finish("provider_stop", r.optional_int(msg, "sequenceNumber"))
        else:
            self._ignore()

    async def send_audio(self, payload: bytes, fmt: AudioFormat) -> None:
        require_capability(self.capabilities(), "playback")
        if fmt != self.input_format or fmt.sample_rate not in _PLAYBACK_RATES:
            raise ProviderError(
                code="unsupported_format",
                provider=PLIVO,
                capability="playback",
                message="Plivo playAudio must match the stream's content type and use 8000 or 16000 Hz.",
            )
        if not payload:
            raise self._invalid("Cannot play an empty payload.", "playback")
        wire = swap_bytes16(payload) if fmt.encoding == "pcm_s16le" and self._l16_byte_order == "big" else payload
        await self._send_json(
            "playback",
            {
                "event": "playAudio",
                "media": {
                    "contentType": "audio/x-mulaw" if fmt.encoding == "mulaw" else "audio/x-l16",
                    "sampleRate": fmt.sample_rate,
                    "payload": base64.b64encode(wire).decode(),
                },
            },
        )

    async def send_mark(self, name: str) -> None:
        require_capability(self.capabilities(), "playback_marks")
        if not name:
            raise self._invalid("Checkpoint name must not be empty.", "playback_marks")
        await self._send_json("playback_marks", {"event": "checkpoint", "streamId": self.session_id, "name": name})

    async def clear_playback(self) -> None:
        await self._send_json("playback_interruption", {"event": "clearAudio", "streamId": self.session_id})

    async def send_dtmf(self, digits: str) -> None:
        require_capability(self.capabilities(), "dtmf_send")
        if not re.fullmatch(r"[0-9*#A-Da-d]+", digits):
            raise self._invalid(f'"{digits}" is not a DTMF digit string.', "dtmf_send")
        await self._send_json("dtmf_send", {"event": "sendDTMF", "dtmf": digits})

    def _format(self, encoding: str, sample_rate: int, channels: int) -> AudioFormat:
        mapped: AudioEncoding
        if encoding == "audio/x-mulaw":
            mapped = "mulaw"
        elif encoding == "audio/x-l16":
            if self._l16_byte_order is None:
                raise self._invalid(
                    "Plivo's docs do not state the byte order of audio/x-l16. Verify it with your account and "
                    "pass l16_byte_order, or start the stream with audio/x-mulaw."
                )
            mapped = "pcm_s16le"
        else:
            raise ProviderError(code="unsupported_format", provider=PLIVO, message=f"Unsupported Plivo encoding {encoding}.")
        if sample_rate not in SUPPORTED_SAMPLE_RATES:
            raise ProviderError(code="unsupported_format", provider=PLIVO, message=f"Unsupported sample rate {sample_rate} Hz.")
        return AudioFormat(mapped, sample_rate, channels)

    def _track(self, value: str, path: str) -> MediaDirection:
        if value == "inbound":
            return "inbound"
        if value == "outbound":
            return "outbound"
        raise self.reader.fail(f'{path} has unknown track "{value}".')
