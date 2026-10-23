from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from calling_agent_toolkit import (
    CAPABILITIES,
    AudioFormat,
    OutboundCallRequest,
    ProviderError,
    ProviderRegistry,
    StreamConnectionRequest,
    TelephonyProvider,
    WebhookRequest,
)
from calling_agent_toolkit.conformance import MediaConformanceTarget, RecordingConnection, StreamIds, media_conformance_checks
from calling_agent_toolkit.media_session import MediaSessionOptions, event_to_wire
from calling_agent_toolkit.providers.plivo import (
    PlivoCallControl,
    PlivoMediaTransport,
    PlivoSessionOptions,
    validate_plivo_request,
)
from calling_agent_toolkit.providers.telnyx import TelnyxMediaTransport, TelnyxSessionOptions
from calling_agent_toolkit.providers.twilio import TwilioCallControl, TwilioMediaTransport, validate_twilio_request
from calling_agent_toolkit.providers.vonage import VonageAuthorization, VonageMediaTransport, VonageSessionOptions

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"


def load(path: str) -> Any:
    return json.loads((CONTRACTS / path).read_text())


SCHEMA = load("schemas/core.schema.json")
EVENT_VALIDATOR = Draft202012Validator(
    {"$ref": f"{SCHEMA['$id']}#/$defs/TelephonyEvent"},
    registry=Registry().with_resource(SCHEMA["$id"], Resource.from_contents(SCHEMA)),
)


def secret(value: str) -> Any:
    async def resolve() -> str:
        return value

    return resolve


def webhook(raw: dict[str, Any]) -> WebhookRequest:
    return WebhookRequest(raw["method"], raw["url"], raw["headers"], raw["rawBody"])


SIGNATURE_CASES = [
    (provider, case)
    for provider in ("twilio", "plivo")
    for case in load(f"fixtures/providers/{provider}/signatures.json")["cases"]
]


@pytest.mark.parametrize(("provider", "case"), SIGNATURE_CASES, ids=lambda v: v["name"] if isinstance(v, dict) else v)
def test_webhook_signatures_match_official_sdk(provider: str, case: dict[str, Any]) -> None:
    validate = validate_twilio_request if provider == "twilio" else validate_plivo_request
    assert validate(case["authToken"], webhook(case["request"])) is case["valid"]


async def test_call_control_validates_webhooks() -> None:
    good = load("fixtures/providers/twilio/signatures.json")["cases"][0]
    twilio = TwilioCallControl(account_sid="AC1", auth_token=secret(good["authToken"]))
    await twilio.validate_webhook(webhook(good["request"]))
    tampered = {**good["request"], "rawBody": good["request"]["rawBody"] + "x"}
    with pytest.raises(ProviderError) as info:
        await twilio.validate_webhook(webhook(tampered))
    assert info.value.code == "signature_invalid"
    plivo_case = load("fixtures/providers/plivo/signatures.json")["cases"][0]
    await PlivoCallControl(auth_id="MA1", auth_token=secret(plivo_case["authToken"])).validate_webhook(webhook(plivo_case["request"]))


async def test_missing_operations_are_unsupported() -> None:
    with pytest.raises(ProviderError) as info:
        await TwilioCallControl(account_sid="AC1", auth_token=secret("t")).send_dtmf("CA1", "1")
    assert (info.value.code, info.value.capability) == ("unsupported_capability", "dtmf_send")


def test_providers_register() -> None:
    registry = ProviderRegistry()
    registry.register(TelephonyProvider("twilio", TwilioCallControl(account_sid="AC1", auth_token=secret("t")), TwilioMediaTransport()))
    registry.register(TelephonyProvider("plivo", PlivoCallControl(auth_id="MA1", auth_token=secret("t")), PlivoMediaTransport()))
    assert registry.names() == ["twilio", "plivo"]


async def test_twilio_handshake_validation() -> None:
    ws = [c for c in load("fixtures/providers/twilio/signatures.json")["cases"] if c["name"].startswith("media stream")]
    transport = TwilioMediaTransport(auth_token=secret(ws[0]["authToken"]))
    good, bad = (StreamConnectionRequest(c["request"]["url"], c["request"]["headers"]) for c in ws)
    await transport.validate_connection(good)
    with pytest.raises(ProviderError, match="did not match"):
        await transport.validate_connection(bad)
    with pytest.raises(ProviderError) as info:
        await TwilioMediaTransport().validate_connection(good)
    assert info.value.code == "invalid_configuration"


async def test_plivo_handshake_needs_host_validator() -> None:
    req = StreamConnectionRequest("wss://example.com/media?token=x", {})
    with pytest.raises(ProviderError) as info:
        await PlivoMediaTransport().validate_connection(req)
    assert info.value.code == "invalid_configuration"

    async def check(r: StreamConnectionRequest) -> bool:
        return r.url.endswith("token=x")

    transport = PlivoMediaTransport(connection_validator=check)
    await transport.validate_connection(req)
    with pytest.raises(ProviderError) as info:
        await transport.validate_connection(StreamConnectionRequest("wss://example.com/media", {}))
    assert info.value.code == "authentication_failed"


def session_options(provider: str, raw: dict[str, Any]) -> Any:
    common: dict[str, Any] = {"bidirectional": raw.get("bidirectional"), "now": lambda: 1000}
    if provider == "plivo":
        return PlivoSessionOptions(**common, l16_byte_order=raw.get("l16ByteOrder"))
    if provider == "telnyx":
        return TelnyxSessionOptions(**common, l16_byte_order=raw.get("l16ByteOrder"))
    if provider == "vonage":
        return VonageSessionOptions(call_id=raw["callId"], session_id=raw["sessionId"], now=lambda: 1000)
    return MediaSessionOptions(**common)


def to_format(raw: dict[str, Any]) -> AudioFormat:
    return AudioFormat(raw["encoding"], raw["sampleRate"], raw["channels"])


async def run_action(session: Any, action: dict[str, Any]) -> None:
    op = action["op"]
    if op == "sendAudio":
        await session.send_audio(base64.b64decode(action["payloadBase64"]), to_format(action["format"]))
    elif op == "sendMark":
        await session.send_mark(action["name"])
    elif op == "clearPlayback":
        await session.clear_playback()
    elif op == "sendDtmf":
        await session.send_dtmf(action["digits"])
    else:
        raise AssertionError(f"unknown op {op}")


SESSION_CASES = [
    (provider, case)
    for provider in ("twilio", "plivo", "telnyx", "vonage")
    for case in load(f"fixtures/providers/{provider}/sessions.json")["cases"]
]


@pytest.mark.parametrize(("provider", "case"), SESSION_CASES, ids=lambda v: v["name"] if isinstance(v, dict) else v)
async def test_session_fixtures(provider: str, case: dict[str, Any]) -> None:
    transport: Any = {
        "twilio": TwilioMediaTransport,
        "plivo": PlivoMediaTransport,
        "telnyx": TelnyxMediaTransport,
        "vonage": VonageMediaTransport,
    }[provider]()
    connection = RecordingConnection()
    session: Any = transport.create_session(connection, session_options(provider, case["options"]))
    for i, step in enumerate(case["steps"]):
        sent_before = len(connection.sent)
        binary_before = len(connection.binary)

        async def run(step: dict[str, Any] = step) -> None:
            if "receive" in step:
                session.receive(json.dumps(step["receive"]))
            elif "receiveRaw" in step:
                session.receive(step["receiveRaw"])
            elif "receiveBinaryHex" in step:
                session.receive(bytes.fromhex(step["receiveBinaryHex"]))
            else:
                await run_action(session, step["action"])

        if "expectError" in step:
            with pytest.raises(ProviderError) as info:
                await run()
            assert info.value.code == step["expectError"], f"step {i}: {info.value.message}"
            assert len(connection.sent) == sent_before, f"step {i} wrote despite failing"
            assert len(connection.binary) == binary_before, f"step {i} wrote binary despite failing"
        else:
            await run()
        if "expectSent" in step:
            assert json.loads(connection.sent[-1]) == step["expectSent"], f"step {i}"
        if "expectSentBinaryHex" in step:
            assert connection.binary[-1].hex() == step["expectSentBinaryHex"], f"step {i}"
    await session.close()
    wire = [event_to_wire(e) async for e in session.events()]
    for event in wire:
        EVENT_VALIDATOR.validate(event)
    assert wire == case["expectEvents"]


MULAW = AudioFormat("mulaw", 8000, 1)
TARGETS = [
    MediaConformanceTarget(
        name="telnyx",
        create_adapter=TelnyxMediaTransport,
        input_format=MULAW,
        start_message=lambda ids: json.dumps({
            "event": "start", "sequence_number": "1", "stream_id": ids.session_id,
            "start": {"call_control_id": ids.call_id, "media_format": {"encoding": "PCMU", "sample_rate": 8000, "channels": 1}},
        }),
        media_message=lambda ids, payload, seq: json.dumps({
            "event": "media", "sequence_number": str(seq), "stream_id": ids.session_id,
            "media": {"track": "inbound", "chunk": str(seq), "timestamp": "0", "payload": payload},
        }),
        stop_message=lambda ids: json.dumps({
            "event": "stop", "sequence_number": "99", "stream_id": ids.session_id, "stop": {"call_control_id": ids.call_id},
        }),
    ),
    MediaConformanceTarget(
        name="twilio",
        create_adapter=TwilioMediaTransport,
        input_format=MULAW,
        start_message=lambda ids: json.dumps({
            "event": "start", "sequenceNumber": "1", "streamSid": ids.session_id,
            "start": {"streamSid": ids.session_id, "callSid": ids.call_id, "accountSid": "AC1", "tracks": ["inbound"],
                      "mediaFormat": {"encoding": "audio/x-mulaw", "sampleRate": 8000, "channels": 1}},
        }),
        media_message=lambda ids, payload, seq: json.dumps({
            "event": "media", "sequenceNumber": str(seq), "streamSid": ids.session_id,
            "media": {"track": "inbound", "chunk": str(seq), "timestamp": "0", "payload": payload},
        }),
        stop_message=lambda ids: json.dumps({
            "event": "stop", "sequenceNumber": "99", "streamSid": ids.session_id,
            "stop": {"accountSid": "AC1", "callSid": ids.call_id},
        }),
    ),
    MediaConformanceTarget(
        name="plivo",
        create_adapter=PlivoMediaTransport,
        input_format=MULAW,
        start_message=lambda ids: json.dumps({
            "event": "start", "sequenceNumber": 0,
            "start": {"callId": ids.call_id, "streamId": ids.session_id, "accountId": "MA1", "tracks": ["inbound"],
                      "mediaFormat": {"encoding": "audio/x-mulaw", "sampleRate": 8000}},
        }),
        media_message=lambda ids, payload, seq: json.dumps({
            "event": "media", "sequenceNumber": seq, "streamId": ids.session_id,
            "media": {"track": "inbound", "timestamp": "1729670400000", "chunk": seq, "payload": payload},
        }),
    ),
]

CONFORMANCE = [(t.name, check) for t in TARGETS for check in media_conformance_checks(t)]


@pytest.mark.parametrize(("provider", "check"), CONFORMANCE, ids=lambda v: getattr(v, "name", v))
async def test_conformance(provider: str, check: Any) -> None:
    await check.run()


@pytest.mark.parametrize("target", TARGETS, ids=lambda t: t.name)
def test_declares_every_capability(target: MediaConformanceTarget) -> None:
    assert sorted(target.create_adapter().capabilities().capabilities) == sorted(CAPABILITIES)


def test_stream_ids_are_plain_data() -> None:
    assert StreamIds("a", "b") == StreamIds("a", "b")


# --- Vonage WebSocket authorization -------------------------------------------------------------

import base64 as _b64
import hashlib as _hashlib
import hmac as _hmac

NOW_MS = 1_800_000_000_000


def _enc(obj: dict[str, Any]) -> str:
    return _b64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()


def sign(payload: dict[str, Any], secret: str, alg: str = "HS256") -> str:
    head, body = _enc({"alg": alg, "typ": "JWT"}), _enc(payload)
    sig = _b64.urlsafe_b64encode(_hmac.new(secret.encode(), f"{head}.{body}".encode(), _hashlib.sha256).digest()).rstrip(b"=").decode()
    return f"{head}.{body}.{sig}"


def ws_request(authorization: str | None = None) -> StreamConnectionRequest:
    return StreamConnectionRequest("wss://example.com/socket", {"Authorization": authorization} if authorization else {})


async def test_vonage_custom_authorization() -> None:
    t = VonageMediaTransport(authorization=VonageAuthorization("custom", expected=secret("Token abc")))
    await t.validate_connection(ws_request("Token abc"))
    with pytest.raises(ProviderError) as info:
        await t.validate_connection(ws_request("Token abd"))
    assert info.value.code == "authentication_failed"


async def test_vonage_jwt_authorization() -> None:
    t = VonageMediaTransport(authorization=VonageAuthorization("vonage", signature_secret=secret("sig-secret"), now=lambda: NOW_MS))
    iat = NOW_MS / 1000 - 10
    await t.validate_connection(ws_request(f"Bearer {sign({'iat': iat}, 'sig-secret')}"))
    for bad in (
        sign({"iat": iat}, "other-secret"),
        sign({"iat": iat - 3600}, "sig-secret"),
        sign({"iat": iat, "exp": iat}, "sig-secret"),
        sign({"iat": iat}, "sig-secret", "none"),
        sign({}, "sig-secret"),
        "not-a-jwt",
    ):
        with pytest.raises(ProviderError) as info:
            await t.validate_connection(ws_request(f"Bearer {bad}"))
        assert info.value.code == "authentication_failed"


async def test_vonage_authorization_must_be_configured() -> None:
    with pytest.raises(ProviderError) as info:
        await VonageMediaTransport().validate_connection(ws_request("x"))
    assert info.value.code == "invalid_configuration"
