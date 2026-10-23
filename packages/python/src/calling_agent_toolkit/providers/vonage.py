# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Vasik Mansuri
"""Vonage Voice API WebSockets.

Protocol: https://developer.vonage.com/en/voice/voice-api/concepts/websockets
A websocket:connected text message announces audio/l16;rate=N, then audio flows as binary 16-bit
little-endian PCM in both directions. Vonage sends no call id on the socket; the host supplies it.
Call control (Vonage Voice REST API) is not implemented: register Vonage with call_control=None.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from ..adapters import MediaConnection, SecretResolver, StreamConnectionRequest
from ..audio import bytes_per_sample, validate_audio_payload
from ..capabilities import require_capability
from ..errors import ProviderError
from ..parse import DTMF_DIGIT, MessageReader, get_header
from ..transports import BinaryMediaSession
from ..types import CAPABILITIES, AudioFormat, AudioFrame, Capability, CapabilityEntry, ProviderCapabilities

VONAGE = "vonage"
_ADAPTER_VERSION = "0.1.0"
_RATES = (8000, 16000, 24000)
_CONTENT_TYPE = re.compile(r"^audio/l16\s*;\s*rate=(\d+)$", re.IGNORECASE)


@dataclass(frozen=True)
class VonageAuthorization:
    """mode "custom": compare the Authorization header to ``expected``.
    mode "vonage": verify a Bearer HS256 JWT signed with ``signature_secret``."""

    mode: Literal["custom", "vonage"]
    expected: SecretResolver | None = None
    signature_secret: SecretResolver | None = None
    max_age_seconds: int = 300
    now: Callable[[], float] | None = None


def _b64url(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def verify_vonage_jwt(token: str, secret: str, *, now_ms: float | None = None, max_age_seconds: int = 300) -> bool:
    """Verify an HS256 JWT signed with the Vonage signature secret. Requires iat within max_age_seconds;
    honours exp and nbf."""
    parts = token.split(".")
    if len(parts) != 3:
        return False
    h, p, s = parts
    try:
        header = json.loads(_b64url(h))
        payload = json.loads(_b64url(p))
    except (ValueError, TypeError):
        return False
    if not isinstance(header, dict) or header.get("alg") != "HS256" or not isinstance(payload, dict):
        return False
    expected = base64.urlsafe_b64encode(hmac.new(secret.encode(), f"{h}.{p}".encode(), hashlib.sha256).digest()).rstrip(b"=").decode()
    if not hmac.compare_digest(expected, s):
        return False
    now = (now_ms if now_ms is not None else time.time() * 1000) / 1000
    iat, exp, nbf = payload.get("iat"), payload.get("exp"), payload.get("nbf")
    if not isinstance(iat, (int, float)) or isinstance(iat, bool) or now - iat > max_age_seconds or iat - now > 60:
        return False
    if isinstance(exp, (int, float)) and not isinstance(exp, bool) and exp < now:
        return False
    if isinstance(nbf, (int, float)) and not isinstance(nbf, bool) and nbf > now + 60:
        return False
    return True


def _capabilities(has_auth: bool, can_send_binary: bool) -> ProviderCapabilities:
    caps: dict[Capability, CapabilityEntry] = {
        c: CapabilityEntry("unsupported", "Call-control capability; the Vonage Voice REST API is not implemented.")
        for c in CAPABILITIES
    }
    playback = (
        CapabilityEntry("supported")
        if can_send_binary
        else CapabilityEntry("requires_configuration", "The connection must implement send_binary.")
    )
    caps.update(
        {
            "live_inbound_audio": CapabilityEntry("supported"),
            "bidirectional_audio": playback,
            "playback": playback,
            "playback_marks": playback,
            "playback_interruption": playback,
            "dtmf_receive": CapabilityEntry("supported"),
            "dtmf_send": CapabilityEntry("unsupported", "Vonage sends DTMF through the REST API (not implemented)."),
            "separate_tracks": CapabilityEntry("unavailable_from_provider", "The socket carries one audio stream."),
            "stream_auth_validation": CapabilityEntry("supported", "Custom header value or Vonage-signed HS256 JWT.")
            if has_auth
            else CapabilityEntry("requires_configuration", "Configure websocket authorization in the NCCO and pass it here."),
        }
    )
    return ProviderCapabilities(provider=VONAGE, adapter_version=_ADAPTER_VERSION, capabilities=caps)


@dataclass(frozen=True)
class VonageSessionOptions:
    call_id: str
    session_id: str
    max_queued_events: int = 500
    max_payload_bytes: int = 64 * 1024
    now: Callable[[], float] | None = None


class VonageMediaTransport:
    provider = VONAGE

    def __init__(self, *, authorization: VonageAuthorization | None = None) -> None:
        self._auth = authorization

    def capabilities(self) -> ProviderCapabilities:
        return _capabilities(self._auth is not None, True)

    async def validate_connection(self, req: StreamConnectionRequest) -> None:
        require_capability(self.capabilities(), "stream_auth_validation")
        auth = self._auth
        assert auth is not None
        header = get_header(req.headers, "authorization") or ""
        if auth.mode == "custom":
            assert auth.expected is not None
            ok = hmac.compare_digest(header.encode(), (await auth.expected()).encode())
        else:
            assert auth.signature_secret is not None
            now_ms = auth.now() if auth.now else None
            ok = header.startswith("Bearer ") and verify_vonage_jwt(
                header[7:], await auth.signature_secret(), now_ms=now_ms, max_age_seconds=auth.max_age_seconds
            )
        if not ok:
            raise ProviderError(code="authentication_failed", provider=VONAGE, message="Vonage WebSocket authorization failed.")

    def create_session(self, connection: MediaConnection, options: VonageSessionOptions) -> VonageMediaSession:
        return VonageMediaSession(connection, options)


class VonageMediaSession(BinaryMediaSession):
    def __init__(self, connection: MediaConnection, options: VonageSessionOptions) -> None:
        super().__init__(
            VONAGE, connection, call_id=options.call_id, session_id=options.session_id,
            max_queued_events=options.max_queued_events, max_payload_bytes=options.max_payload_bytes, now=options.now,
        )
        self._reader = MessageReader(VONAGE)
        self._samples = 0
        self._chunks = 0
        self.ignored_messages = 0

    def capabilities(self) -> ProviderCapabilities:
        return _capabilities(False, self._send_binary() is not None)

    def receive(self, message: str | bytes) -> None:
        self._require_open()
        if not isinstance(message, str):
            self._audio(message)
            return
        msg = self._reader.json(message)
        event = msg["event"]
        if event == "websocket:connected":
            if self.input_format is not None:
                raise self._violation("websocket:connected arrived twice.")
            content_type = self._reader.string(msg, "content-type")
            match = _CONTENT_TYPE.match(content_type.strip())
            rate = int(match.group(1)) if match else 0
            if rate not in _RATES:
                raise ProviderError(code="unsupported_format", provider=VONAGE, message=f"Unsupported Vonage content-type {content_type}.")
            custom = {k: v for k, v in msg.items() if k not in ("event", "content-type") and isinstance(v, str)}
            self._start(AudioFormat("pcm_s16le", rate, 1), bidirectional=True, custom_parameters=custom or None)
        elif event == "websocket:dtmf":
            self._require_started(event)
            digit = self._reader.string(msg, "digit")
            if not DTMF_DIGIT.match(digit):
                raise self._reader.fail("digit must be a single DTMF character.")
            self._emit_event(self._event("dtmf", None, digit=digit, direction="inbound"))
        elif event == "websocket:notify":
            self._require_started(event)
            payload = msg.get("payload")
            if isinstance(payload, dict) and isinstance(payload.get("name"), str):
                self._emit_event(self._event("playback_mark", None, name=payload["name"]))
            else:
                self.ignored_messages += 1
        elif event == "websocket:cleared":
            self._require_started(event)
            self._emit_event(self._event("playback_cleared", None))
        else:
            self.ignored_messages += 1

    async def send_audio(self, payload: bytes, fmt: AudioFormat) -> None:
        require_capability(self.capabilities(), "playback")
        self._require_open()
        if self.input_format is None:
            raise self._violation("Cannot play audio before websocket:connected.")
        if fmt != self.input_format:
            raise ProviderError(
                code="unsupported_format", provider=VONAGE, capability="playback", message="Playback must match the socket's content-type."
            )
        if not payload:
            raise ProviderError(code="invalid_configuration", provider=VONAGE, message="Cannot play an empty payload.")
        send = self._send_binary()
        assert send is not None
        await send(payload)

    async def send_mark(self, name: str) -> None:
        require_capability(self.capabilities(), "playback_marks")
        self._require_open()
        await self._connection.send_text(json.dumps({"action": "notify", "payload": {"name": name}}))

    async def clear_playback(self) -> None:
        require_capability(self.capabilities(), "playback_interruption")
        self._require_open()
        await self._connection.send_text(json.dumps({"action": "clear"}))

    def _audio(self, message: bytes) -> None:
        fmt = self.input_format
        if fmt is None:
            raise self._violation("Binary audio arrived before websocket:connected.")
        validate_audio_payload(fmt, len(message), self._max_payload_bytes, VONAGE)
        timestamp = self._samples * 1000 / fmt.sample_rate
        self._samples += len(message) // bytes_per_sample(fmt)
        frame = AudioFrame(
            call_id=self.call_id, session_id=self.session_id, provider=VONAGE, direction="inbound", format=fmt,
            payload=bytes(message), timestamp_kind="stream_relative_ms", timestamp_ms=timestamp, chunk=self._chunks,
        )
        self._chunks += 1
        self._emit_audio(frame, None)

    def _require_started(self, event: Any) -> None:
        if self.input_format is None:
            raise self._violation(f"{event} arrived before websocket:connected.")

    def _violation(self, message: str) -> ProviderError:
        return ProviderError(code="protocol_violation", provider=VONAGE, message=message)
