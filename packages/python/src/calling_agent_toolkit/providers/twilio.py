# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Vasik Mansuri
"""Twilio adapters.

Media Streams protocol: https://www.twilio.com/docs/voice/media-streams/websocket-messages
Signatures: https://www.twilio.com/docs/usage/webhooks/webhooks-security (mirrors twilio-python RequestValidator)
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import time
from collections.abc import Callable, Mapping, Sequence
from urllib.parse import parse_qs, parse_qsl, quote, urlencode
from xml.sax.saxutils import escape as xml_escape

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
from ..audio import validate_audio_payload
from ..capabilities import require_capability
from ..errors import ProviderError
from ..http import HttpClient, HttpRequest, HttpResponse, basic_auth, call_api, json_body, urllib_http_client
from ..media_session import BaseMediaSession, MediaSessionOptions
from ..parse import DTMF_DIGIT, JsonObject, get_header
from ..types import (
    SUPPORTED_SAMPLE_RATES,
    AdapterHealth,
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

TWILIO = "twilio"
_ADAPTER_VERSION = "0.1.0"
_MULAW_8K = AudioFormat("mulaw", 8000, 1)

# ---------------------------------------------------------------------------------------------
# Signatures

_URL = re.compile(r"^([a-z][a-z0-9+.-]*://)([^/?#]*)(.*)$", re.IGNORECASE | re.DOTALL)


def _port_variants(url: str) -> list[str]:
    """The URL as given plus its default-port twin; Twilio signs either form inconsistently."""
    match = _URL.match(url)
    if not match:
        return [url]
    scheme, authority, rest = match.groups()
    port = re.search(r":(\d+)$", authority)
    if port:
        return [url, scheme + authority[: port.start()] + rest]
    default_port = 443 if re.match(r"^(https|wss):", scheme, re.IGNORECASE) else 80
    return [url, f"{scheme}{authority}:{default_port}{rest}"]


def compute_twilio_signature(auth_token: str, url: str, params: Mapping[str, Sequence[str]] | None = None) -> str:
    """HMAC-SHA1 over the URL followed by sorted, de-duplicated name+value pairs."""
    data = url
    for name in sorted(params or {}):
        for value in sorted(set((params or {})[name])):
            data += name + value
    digest = hmac.new(auth_token.encode(), data.encode(), hashlib.sha1).digest()
    return base64.b64encode(digest).decode()


def validate_twilio_request(auth_token: str, req: WebhookRequest) -> bool:
    """Validate a webhook or Media Streams handshake. Returns False rather than raising."""
    signature = get_header(req.headers, "x-twilio-signature")
    if not signature:
        return False
    params: dict[str, list[str]] = {}
    query = req.url.split("#", 1)[0].partition("?")[2]
    body_hash = parse_qs(query).get("bodySHA256")
    content_type = (get_header(req.headers, "content-type") or "").lower()
    if body_hash:
        computed = hashlib.sha256(req.raw_body.encode()).hexdigest()
        if not hmac.compare_digest(computed, body_hash[0]):
            return False
    elif req.method.upper() == "POST" and content_type.startswith("application/x-www-form-urlencoded"):
        for name, value in parse_qsl(req.raw_body, keep_blank_values=True):
            params.setdefault(name, []).append(value)
    return any(
        hmac.compare_digest(compute_twilio_signature(auth_token, url, params), signature)
        for url in _port_variants(req.url)
    )


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
    "stream_recovery",
)
_BIDIRECTIONAL_DEPENDENT: tuple[Capability, ...] = (
    "bidirectional_audio",
    "playback",
    "playback_marks",
    "playback_interruption",
    "dtmf_receive",
)
_NEEDS_CONNECT = CapabilityEntry(
    "requires_configuration",
    "Requires a bidirectional <Connect><Stream>; pass bidirectional=True when creating the session.",
)


def _media_capabilities(has_auth_token: bool) -> ProviderCapabilities:
    caps: dict[Capability, CapabilityEntry] = {
        c: CapabilityEntry("unsupported", "Call-control capability; see TwilioCallControl.") for c in _CALL_CONTROL_ONLY
    }
    caps.update(
        {
            "live_inbound_audio": CapabilityEntry("supported"),
            "live_outbound_audio": CapabilityEntry(
                "supported", 'Requires track="outbound_track" or "both_tracks" on <Start><Stream>.'
            ),
            "separate_tracks": CapabilityEntry("supported"),
            "bidirectional_audio": _NEEDS_CONNECT,
            "playback": _NEEDS_CONNECT,
            "playback_marks": _NEEDS_CONNECT,
            "playback_interruption": _NEEDS_CONNECT,
            "dtmf_receive": _NEEDS_CONNECT,
            "dtmf_send": CapabilityEntry("unavailable_from_provider", "Media Streams has no message for sending DTMF."),
            "stream_auth_validation": CapabilityEntry(
                "supported", "Validates the lowercase x-twilio-signature header on the WebSocket handshake."
            )
            if has_auth_token
            else CapabilityEntry("requires_configuration", "Pass auth_token to TwilioMediaTransport."),
            "provider_noise_suppression": CapabilityEntry(
                "unsupported", "No noise-suppression option found in the Media Streams docs reviewed on 2026-10-23."
            ),
            "stream_recovery": CapabilityEntry(
                "unsupported", "Twilio does not document resuming a stream after disconnect."
            ),
        }
    )
    return ProviderCapabilities(
        provider=TWILIO,
        adapter_version=_ADAPTER_VERSION,
        capabilities=caps,
        supported_input_formats=(_MULAW_8K,),
        supported_playback_formats=(_MULAW_8K,),
    )


def _call_control_capabilities() -> ProviderCapabilities:
    media = CapabilityEntry("unsupported", "Media capability; see TwilioMediaTransport.")
    caps: dict[Capability, CapabilityEntry] = {c: media for c in _MEDIA_ONLY}
    caps.update(
        {
            "provider_noise_suppression": media,
            "inbound_calls": CapabilityEntry(
                "supported", "Twilio calls your voice webhook; respond with TwiML. parse_webhook normalizes status callbacks."
            ),
            "outbound_calls": CapabilityEntry("supported"),
            "answer_call": CapabilityEntry("unavailable_from_provider", "Calls are answered by returning TwiML from your webhook."),
            "end_call": CapabilityEntry("supported"),
            "call_transfer": CapabilityEntry("supported", "Replaces the call's TwiML with <Dial>; an active <Connect><Stream> ends."),
            "call_status_events": CapabilityEntry("supported"),
            "media_stream_control": CapabilityEntry(
                "supported", "REST-created streams are unidirectional; return <Connect><Stream> TwiML for bidirectional audio."
            ),
            "recording_access": CapabilityEntry("unsupported", "Not implemented yet."),
            "dtmf_send": CapabilityEntry("unsupported", "Twilio has no REST DTMF operation that keeps the current TwiML running."),
            "webhook_validation": CapabilityEntry("supported", "X-Twilio-Signature, including bodySHA256 JSON bodies."),
        }
    )
    return ProviderCapabilities(provider=TWILIO, adapter_version=_ADAPTER_VERSION, capabilities=caps)


# ---------------------------------------------------------------------------------------------
# Adapters


_TWILIO_STATUS: dict[str, CallStatus] = {
    "queued": "queued",
    "initiated": "queued",
    "ringing": "ringing",
    "in-progress": "in_progress",
    "answered": "in_progress",
    "completed": "completed",
    "busy": "busy",
    "failed": "failed",
    "no-answer": "no_answer",
    "canceled": "canceled",
}


def _invalid(message: str) -> ProviderError:
    return ProviderError(code="invalid_configuration", provider=TWILIO, message=message)


def _seg(value: str) -> str:
    return quote(value, safe="")


class TwilioCallControl(BaseCallControlAdapter):
    """Twilio REST call control (Calls and Streams resources) plus webhook validation and parsing."""

    provider = TWILIO

    def __init__(
        self,
        *,
        account_sid: str,
        auth_token: SecretResolver,
        http: HttpClient | None = None,
        base_url: str = "https://api.twilio.com",
        timeout_s: float = 10.0,
        now: Callable[[], float] | None = None,
    ) -> None:
        if not account_sid:
            raise _invalid("account_sid is required.")
        self._account_sid = account_sid
        self._auth_token = auth_token
        self._http: HttpClient = http or urllib_http_client
        self._base_url = base_url.rstrip("/")
        self._timeout_s = timeout_s
        self._now = now or (lambda: time.time() * 1000)

    def capabilities(self) -> ProviderCapabilities:
        return _call_control_capabilities()

    async def validate_webhook(self, req: WebhookRequest) -> None:
        if not validate_twilio_request(await self._auth_token(), req):
            raise ProviderError(code="signature_invalid", provider=TWILIO, message="X-Twilio-Signature did not match.")

    async def parse_webhook(self, req: WebhookRequest) -> list[TelephonyEvent]:
        """Parse a status callback. Call validate_webhook first; this method does not authenticate."""
        form = dict(parse_qsl(req.raw_body, keep_blank_values=True))
        call_sid, status = form.get("CallSid"), form.get("CallStatus")
        if not call_sid or not status:
            raise ProviderError(code="malformed_message", provider=TWILIO, message="Status callback needs CallSid and CallStatus.")
        seq = form.get("SequenceNumber")
        return [
            TelephonyEvent(
                type="call_status",
                provider=TWILIO,
                call_id=call_sid,
                session_id=call_sid,
                received_at_ms=self._now(),
                provider_sequence=int(seq) if seq is not None and seq.isdigit() else None,
                data={"status": _TWILIO_STATUS.get(status, "unknown"), "providerStatus": status},
            )
        ]

    async def start_outbound_call(self, req: OutboundCallRequest) -> CallSession:
        require_capability(self.capabilities(), "outbound_calls")
        if not req.to or not req.from_:
            raise _invalid("to and from are required.")
        a = req.answer
        url = a.get("url") if isinstance(a.get("url"), str) else None
        twiml = a.get("twiml") if isinstance(a.get("twiml"), str) else None
        if (url is None) == (twiml is None):
            raise _invalid("Pass exactly one of answer.url or answer.twiml.")
        form: list[tuple[str, str]] = [("To", req.to), ("From", req.from_)]
        form.append(("Url", url) if url is not None else ("Twiml", str(twiml)))
        if isinstance(a.get("statusCallback"), str):
            form.append(("StatusCallback", a["statusCallback"]))
        events = a.get("statusCallbackEvents")
        if events is not None:
            if not isinstance(events, list) or not all(isinstance(e, str) for e in events):
                raise _invalid("answer.statusCallbackEvents must be strings.")
            form += [("StatusCallbackEvent", e) for e in events]
        body = json_body(TWILIO, await self._post("/Calls.json", form))
        if not isinstance(body.get("sid"), str):
            raise self._unexpected()
        status = body.get("status") if isinstance(body.get("status"), str) else ""
        return CallSession(
            call_id=body["sid"],
            provider=TWILIO,
            direction="outbound",
            status=_TWILIO_STATUS.get(str(status), "unknown"),
            from_=req.from_,
            to=req.to,
        )

    async def end_call(self, call_id: str) -> None:
        require_capability(self.capabilities(), "end_call")
        await self._post(f"/Calls/{_seg(call_id)}.json", [("Status", "completed")])

    async def transfer_call(self, call_id: str, target: TransferTarget) -> None:
        require_capability(self.capabilities(), "call_transfer")
        if not target.to:
            raise _invalid("Transfer target is required.")
        twiml = f"<Response><Dial>{xml_escape(target.to, {chr(34): '&quot;', chr(39): '&apos;'})}</Dial></Response>"
        await self._post(f"/Calls/{_seg(call_id)}.json", [("Twiml", twiml)])

    async def start_media_stream(self, call_id: str, req: MediaStreamRequest) -> MediaStreamHandle:
        require_capability(self.capabilities(), "media_stream_control")
        if req.bidirectional:
            raise _invalid(
                "Twilio's Stream resource creates unidirectional streams. Return <Connect><Stream> TwiML for bidirectional audio."
            )
        if not req.url.startswith("wss://"):
            raise _invalid("Stream url must start with wss://.")
        if req.format is not None and req.format != _MULAW_8K:
            raise ProviderError(code="unsupported_format", provider=TWILIO, message="Twilio streams are audio/x-mulaw 8000 Hz mono.")
        tracks = set(req.tracks)
        if {"inbound", "outbound"} <= tracks:
            track = "both_tracks"
        elif "outbound" in tracks:
            track = "outbound_track"
        elif "inbound" in tracks:
            track = "inbound_track"
        else:
            raise _invalid("tracks must include inbound and/or outbound.")
        options = dict(req.provider_options)
        for key in options:
            if key not in ("name", "statusCallback", "customParameters"):
                raise _invalid(f"Unknown Twilio stream option {key}.")
        form = [("Url", req.url), ("Track", track)]
        if isinstance(options.get("name"), str):
            form.append(("Name", options["name"]))
        if isinstance(options.get("statusCallback"), str):
            form.append(("StatusCallback", options["statusCallback"]))
        custom = options.get("customParameters")
        if custom is not None:
            if not isinstance(custom, dict) or len(custom) > 99 or not all(isinstance(v, str) for v in custom.values()):
                raise _invalid("customParameters: at most 99 string values.")
            for i, (k, v) in enumerate(custom.items(), start=1):
                form += [(f"Parameter{i}.Name", k), (f"Parameter{i}.Value", v)]
        body = json_body(TWILIO, await self._post(f"/Calls/{_seg(call_id)}/Streams.json", form))
        if not isinstance(body.get("sid"), str):
            raise self._unexpected()
        return MediaStreamHandle(call_id=call_id, stream_id=body["sid"])

    async def stop_media_stream(self, call_id: str, stream_id: str) -> None:
        require_capability(self.capabilities(), "media_stream_control")
        await self._post(f"/Calls/{_seg(call_id)}/Streams/{_seg(stream_id)}.json", [("Status", "stopped")])

    async def health(self) -> AdapterHealth:
        return AdapterHealth(TWILIO, "healthy", time.time() * 1000, detail="Configuration only; no remote probe.")

    async def _post(self, path: str, form: list[tuple[str, str]]) -> HttpResponse:
        token = await self._auth_token()
        request = HttpRequest(
            method="POST",
            url=f"{self._base_url}/2010-04-01/Accounts/{_seg(self._account_sid)}{path}",
            headers={
                "Authorization": basic_auth(self._account_sid, token),
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "application/json",
            },
            body=urlencode(form),
        )
        return await call_api(TWILIO, self._http, request, timeout_s=self._timeout_s)

    def _unexpected(self) -> ProviderError:
        return ProviderError(code="protocol_violation", provider=TWILIO, message="Twilio response is missing sid.")


class TwilioMediaTransport:
    provider = TWILIO

    def __init__(self, *, auth_token: SecretResolver | None = None) -> None:
        self._auth_token = auth_token

    def capabilities(self) -> ProviderCapabilities:
        return _media_capabilities(self._auth_token is not None)

    async def validate_connection(self, req: StreamConnectionRequest) -> None:
        require_capability(self.capabilities(), "stream_auth_validation")
        assert self._auth_token is not None
        token = await self._auth_token()
        if not validate_twilio_request(token, WebhookRequest("GET", req.url, req.headers, "")):
            raise ProviderError(
                code="signature_invalid",
                provider=TWILIO,
                message="x-twilio-signature on the Media Streams handshake did not match.",
            )

    def create_session(
        self, connection: MediaConnection, options: MediaSessionOptions | None = None
    ) -> TwilioMediaSession:
        return TwilioMediaSession(connection, self.capabilities(), options)


class TwilioMediaSession(BaseMediaSession):
    def __init__(
        self, connection: MediaConnection, capabilities: ProviderCapabilities, options: MediaSessionOptions | None = None
    ) -> None:
        super().__init__(TWILIO, connection, capabilities, _BIDIRECTIONAL_DEPENDENT, options)

    def _handle(self, msg: JsonObject) -> None:
        r = self.reader
        event = msg["event"]
        if event == "connected":
            if self.state != "awaiting_start":
                raise self._error("protocol_violation", "connected arrived after start.")
        elif event == "start":
            if self.state != "awaiting_start":
                raise self._error("protocol_violation", "Received a second start message.")
            seq = r.optional_int(msg, "sequenceNumber")
            start = r.object(msg, "start")
            stream_sid = r.id(start, "streamSid", "start.streamSid")
            call_sid = r.id(start, "callSid", "start.callSid")
            tracks = [self._track(t, "start.tracks") for t in r.string_list(start, "tracks", "start.tracks")]
            mf = r.object(start, "mediaFormat", "start.mediaFormat")
            encoding = r.string(mf, "encoding", "start.mediaFormat.encoding")
            fmt = AudioFormat(
                "mulaw",
                r.int(mf, "sampleRate", "start.mediaFormat.sampleRate"),
                r.int(mf, "channels", "start.mediaFormat.channels"),
            )
            if encoding != "audio/x-mulaw" or fmt.sample_rate not in SUPPORTED_SAMPLE_RATES:
                raise ProviderError(
                    code="unsupported_format",
                    provider=TWILIO,
                    message=f"Unsupported Twilio media format {encoding} at {fmt.sample_rate} Hz.",
                )
            custom = self._custom_parameters(start)
            self._begin(call_sid, stream_sid, fmt)
            data: dict[str, object] = {"tracks": tracks, "format": fmt, "bidirectional": self.bidirectional}
            if custom is not None:
                data["customParameters"] = custom
            self._emit(self._event("stream_started", seq, **data))
        elif event == "media":
            self._require_active(event)
            self._require_same_stream(r.optional_string(msg, "streamSid"))
            seq = r.optional_int(msg, "sequenceNumber")
            media = r.object(msg, "media")
            direction = self._track(r.string(media, "track", "media.track"), "media.track")
            timestamp = r.optional_int(media, "timestamp", "media.timestamp")
            chunk = r.optional_int(media, "chunk", "media.chunk")
            payload = r.base64(media, "payload", "media.payload")
            assert self.input_format is not None and self.call_id is not None and self.session_id is not None
            validate_audio_payload(self.input_format, len(payload), self.max_payload_bytes, TWILIO)
            frame = AudioFrame(
                call_id=self.call_id,
                session_id=self.session_id,
                provider=TWILIO,
                direction=direction,
                format=self.input_format,
                payload=payload,
                timestamp_kind="none" if timestamp is None else "stream_relative_ms",
                timestamp_ms=timestamp,
                sequence_number=seq,
                chunk=chunk,
                is_complete_frame=False,
            )
            self._emit(self._event("audio", seq, frame=frame))
        elif event == "dtmf":
            self._require_active(event)
            self._require_same_stream(r.optional_string(msg, "streamSid"))
            seq = r.optional_int(msg, "sequenceNumber")
            dtmf = r.object(msg, "dtmf")
            digit = r.string(dtmf, "digit", "dtmf.digit")
            if not DTMF_DIGIT.match(digit):
                raise r.fail("dtmf.digit must be a single DTMF character.")
            track = r.optional_string(dtmf, "track", "dtmf.track")
            extra = {} if track is None else {"direction": self._track(track, "dtmf.track")}
            self._emit(self._event("dtmf", seq, digit=digit, **extra))
        elif event == "mark":
            self._require_active(event)
            self._require_same_stream(r.optional_string(msg, "streamSid"))
            seq = r.optional_int(msg, "sequenceNumber")
            name = r.string(r.object(msg, "mark"), "name", "mark.name")
            self._emit(self._event("playback_mark", seq, name=name))
        elif event == "stop":
            self._require_active(event)
            self._require_same_stream(r.optional_string(msg, "streamSid"))
            self._finish("provider_stop", r.optional_int(msg, "sequenceNumber"))
        else:
            self._ignore()

    async def send_audio(self, payload: bytes, fmt: AudioFormat) -> None:
        require_capability(self.capabilities(), "playback")
        if fmt != _MULAW_8K:
            raise ProviderError(
                code="unsupported_format",
                provider=TWILIO,
                capability="playback",
                message="Twilio plays audio/x-mulaw 8000 Hz mono only. Resample and encode with encode_mulaw first.",
            )
        if not payload:
            raise self._invalid("Cannot play an empty payload.", "playback")
        await self._send_json(
            "playback",
            {"event": "media", "streamSid": self.session_id, "media": {"payload": base64.b64encode(payload).decode()}},
        )

    async def send_mark(self, name: str) -> None:
        require_capability(self.capabilities(), "playback_marks")
        if not name:
            raise self._invalid("Mark name must not be empty.", "playback_marks")
        await self._send_json("playback_marks", {"event": "mark", "streamSid": self.session_id, "mark": {"name": name}})

    async def clear_playback(self) -> None:
        await self._send_json("playback_interruption", {"event": "clear", "streamSid": self.session_id})

    async def send_dtmf(self, digits: str) -> None:
        require_capability(self.capabilities(), "dtmf_send")

    def _track(self, value: str, path: str) -> MediaDirection:
        if value == "inbound":
            return "inbound"
        if value == "outbound":
            return "outbound"
        raise self.reader.fail(f'{path} has unknown track "{value}".')

    def _custom_parameters(self, start: JsonObject) -> dict[str, str] | None:
        if "customParameters" not in start:
            return None
        params = self.reader.object(start, "customParameters", "start.customParameters")
        for key, value in params.items():
            if not isinstance(value, str):
                raise self.reader.fail(f"start.customParameters.{key} must be a string.")
        return params
