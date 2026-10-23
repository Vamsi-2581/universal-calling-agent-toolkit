from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from calling_agent_toolkit import AudioFormat, ProviderError
from calling_agent_toolkit.audio_pipeline import AudioPipeline
from calling_agent_toolkit.conformance import MediaConformanceTarget, RecordingConnection, media_conformance_checks
from calling_agent_toolkit.transports import (
    GenericJsonConfig,
    GenericJsonMediaTransport,
    RawPcmMediaSession,
    RtpMediaSession,
    RtpPacketizer,
    RtpPayloadFormat,
    file_frames,
    parse_rtp_packet,
    read_wav,
    write_wav_pcm16,
)

FIXTURE = json.loads((Path(__file__).resolve().parents[3] / "contracts/fixtures/transports/rtp-wav.json").read_text())


@pytest.mark.parametrize("case", FIXTURE["rtp"], ids=lambda c: c["name"])
def test_rtp_vectors(case: dict[str, Any]) -> None:
    data = bytes.fromhex(case["hex"])
    if "expectError" in case:
        with pytest.raises(ProviderError) as info:
            parse_rtp_packet(data)
        assert info.value.code == case["expectError"]
    else:
        assert parse_rtp_packet(data).to_wire() == case["expect"]


@pytest.mark.parametrize("case", FIXTURE["wav"], ids=lambda c: c["name"])
def test_wav_vectors(case: dict[str, Any]) -> None:
    data = bytes.fromhex(case["hex"])
    if "expectError" in case:
        with pytest.raises(ProviderError) as info:
            read_wav(data)
        assert info.value.code == case["expectError"]
    else:
        wav = read_wav(data)
        f = wav.format
        assert {"format": {"encoding": f.encoding, "sampleRate": f.sample_rate, "channels": f.channels}, "dataHex": wav.data.hex()} == case["expect"]


def test_wav_round_trip_and_frames() -> None:
    pcm = bytes(i % 251 for i in range(1600))
    wav = read_wav(write_wav_pcm16(pcm, 16000))
    assert wav.format == AudioFormat("pcm_s16le", 16000, 1)
    frames = file_frames(wav, call_id="rec-1", session_id="rec-1")
    assert [(len(f.payload), f.is_complete_frame, f.timestamp_ms) for f in frames] == [(640, True, 0), (640, True, 20), (320, False, 40)]
    assert b"".join(f.payload for f in frames) == pcm


async def drain(session: Any) -> list[Any]:
    await session.close()
    return [e async for e in session.events()]


def packetizer() -> RtpPacketizer:
    return RtpPacketizer(payload_type=0, ssrc=42, initial_sequence=65534, initial_timestamp=4294967136)


async def test_rtp_wraparound_gaps_duplicates_timestamps() -> None:
    p = packetizer()
    packets = [p.packetize(b"\xff" * 160, 160) for _ in range(4)]
    session = RtpMediaSession(RecordingConnection(), call_id="c", session_id="s", now=lambda: 0)
    for i in (0, 0, 2, 1, 3):
        session.receive(packets[i])
    assert session.stats == {"packets": 3, "lostPackets": 1, "latePackets": 2, "ssrcChanges": 0}
    audio = [e for e in await drain(session) if e.type == "audio"]
    assert [(e.data["frame"].sequence_number, e.data["frame"].timestamp_ms) for e in audio] == [(65534, 0), (0, 40), (1, 60)]


def test_rtp_l16_and_unknown_payload_type() -> None:
    session = RtpMediaSession(
        RecordingConnection(), call_id="c", session_id="s",
        payload_types={118: RtpPayloadFormat(AudioFormat("pcm_s16le", 16000, 1), "big")},
    )
    with pytest.raises(ProviderError, match="payload type 0 is not configured"):
        session.receive(packetizer().packetize(b"\x00\x00", 1))
    session.receive(RtpPacketizer(payload_type=118, ssrc=1).packetize(b"\x00\x01", 1))
    assert session.input_format == AudioFormat("pcm_s16le", 16000, 1)


class BinaryConnection(RecordingConnection):
    def __init__(self) -> None:
        super().__init__()
        self.binary: list[bytes] = []

    async def send_binary(self, data: bytes) -> None:
        self.binary.append(data)


async def test_rtp_playback_only_when_configured() -> None:
    conn = BinaryConnection()
    mulaw = AudioFormat("mulaw", 8000, 1)
    with pytest.raises(ProviderError) as info:
        await RtpMediaSession(conn, call_id="c", session_id="s").send_audio(b"\x00" * 160, mulaw)
    assert info.value.code == "invalid_configuration"
    live = RtpMediaSession(conn, call_id="c", session_id="s", playback=(0, 7))
    await live.send_audio(b"\xff" * 160, mulaw)
    await live.send_audio(b"\xff" * 160, mulaw)
    a, b = (parse_rtp_packet(d) for d in conn.binary)
    assert (a.ssrc, a.sequence_number, b.sequence_number, b.timestamp - a.timestamp) == (7, 0, 1, 160)


L16 = AudioFormat("pcm_s16le", 16000, 1)


async def test_raw_pcm_frames_and_text() -> None:
    texts: list[str] = []
    session = RawPcmMediaSession(RecordingConnection(), call_id="c", session_id="s", format=L16, on_text=texts.append, now=lambda: 0)
    session.receive('{"event":"websocket:connected"}')
    session.receive(b"\x00" * 640)
    session.receive(b"\x00" * 640)
    with pytest.raises(ProviderError) as info:
        session.receive(b"\x00" * 3)
    assert info.value.code == "malformed_message"
    events = await drain(session)
    assert texts == ['{"event":"websocket:connected"}']
    assert [e.type for e in events] == ["stream_started", "audio", "audio", "stream_stopped"]
    assert [e.data["frame"].timestamp_ms for e in events if e.type == "audio"] == [0, 20]


async def test_raw_pcm_playback_needs_binary_connection() -> None:
    class TextOnly:
        async def send_text(self, data: str) -> None: ...
        async def close(self, code: int | None = None, reason: str | None = None) -> None: ...

    session = RawPcmMediaSession(TextOnly(), call_id="c", session_id="s", format=L16, bidirectional=True)
    with pytest.raises(ProviderError) as info:
        await session.send_audio(b"\x00" * 640, L16)
    assert info.value.code == "invalid_configuration"


def generic() -> GenericJsonMediaTransport:
    return GenericJsonMediaTransport(
        GenericJsonConfig(
            provider="acme",
            event_field="type",
            events={"start": "call.start", "media": "call.audio", "stop": "call.end"},
            paths={"callId": "call.id", "sessionId": "stream.id", "payload": "audio.data", "track": "audio.side", "sequence": "seq"},
            track_values={"caller": "inbound", "agent": "outbound"},
            format=AudioFormat("mulaw", 8000, 1),
        )
    )


TARGET = MediaConformanceTarget(
    name="generic-json",
    create_adapter=generic,
    input_format=AudioFormat("mulaw", 8000, 1),
    start_message=lambda ids: json.dumps({"type": "call.start", "call": {"id": ids.call_id}, "stream": {"id": ids.session_id}}),
    media_message=lambda ids, payload, seq: json.dumps({"type": "call.audio", "seq": seq, "audio": {"data": payload, "side": "caller"}}),
    stop_message=lambda ids: json.dumps({"type": "call.end"}),
)


@pytest.mark.parametrize("check", media_conformance_checks(TARGET), ids=lambda c: c.name)
async def test_generic_json_conformance(check: Any) -> None:
    await check.run()


async def test_generic_json_tracks() -> None:
    session = generic().create_session(RecordingConnection())
    session.receive(json.dumps({"type": "call.start", "call": {"id": "c"}, "stream": {"id": "s"}}))
    session.receive(json.dumps({"type": "call.audio", "seq": 1, "audio": {"data": "fw==", "side": "agent"}}))
    with pytest.raises(ProviderError, match="unknown track"):
        session.receive(json.dumps({"type": "call.audio", "seq": 2, "audio": {"data": "fw==", "side": "bot"}}))
    events = await drain(session)
    assert events[1].data["frame"].direction == "outbound"


def test_recording_uses_the_same_pipeline() -> None:
    wav = read_wav(write_wav_pcm16(b"\x00" * 640, 8000))
    pipeline = AudioPipeline(target_sample_rate=16000)
    out = [o for f in file_frames(wav, call_id="rec", session_id="rec") for o in pipeline.push(f)] + pipeline.flush()
    assert [len(f.payload) for f in out] == [640, 640]
