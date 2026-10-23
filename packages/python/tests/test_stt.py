from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from calling_agent_toolkit import AudioFormat, AudioFrame, ProviderError
from calling_agent_toolkit.audio_pipeline import AudioPipeline
from calling_agent_toolkit.email_capture import EmailCapture
from calling_agent_toolkit.providers.deepgram import (
    DeepgramStreamingSession,
    deepgram_listen_url,
    parse_deepgram_message,
)
from calling_agent_toolkit.stt import SttAudioBridge, SttResult, TranscriptReconciler, transcript_to_wire

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"


def load(path: str) -> Any:
    return json.loads((CONTRACTS / path).read_text())


@pytest.mark.parametrize("case", load("fixtures/stt/reconciler.json")["cases"], ids=lambda c: c["name"])
def test_reconciler(case: dict[str, Any]) -> None:
    reconciler = TranscriptReconciler("t1", "s1", now=lambda: 1000)
    events = [e for raw in case["inputs"] for e in reconciler.accept(SttResult.from_wire(raw))]
    assert [transcript_to_wire(e) for e in events] == case["expect"]


DEEPGRAM_CASES = load("fixtures/providers/deepgram/messages.json")["cases"]


@pytest.mark.parametrize("case", DEEPGRAM_CASES)
def test_deepgram_messages(case: dict[str, Any]) -> None:
    raw = case.get("raw") or json.dumps(case["message"])
    if "expectError" in case:
        with pytest.raises(ProviderError) as info:
            parse_deepgram_message(raw)
        assert info.value.code == case["expectError"]
    else:
        assert [r.to_wire() for r in parse_deepgram_message(raw)] == case["expect"]


PCM_16K = AudioFormat("pcm_s16le", 16000, 1)


def test_listen_url() -> None:
    assert deepgram_listen_url(PCM_16K, utterance_end_ms=1000, model="nova-3") == (
        "wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&channels=1"
        "&interim_results=true&model=nova-3&utterance_end_ms=1000"
    )
    with pytest.raises(ProviderError, match="interim_results"):
        deepgram_listen_url(PCM_16K, utterance_end_ms=1000, interim_results=False)


class FakeSocket:
    def __init__(self) -> None:
        self.binary: list[bytes] = []
        self.text: list[str] = []

    async def send_binary(self, data: bytes) -> None:
        self.binary.append(data)

    async def send_text(self, data: str) -> None:
        self.text.append(data)

    async def close(self) -> None:
        pass


class Invert:
    name = "invert"
    kind = "noise_suppression"
    sample_rate = 16000
    frame_samples = 320

    def process(self, pcm: bytes) -> bytes:
        return bytes(255 - b for b in pcm)


def mulaw_frame() -> AudioFrame:
    return AudioFrame("c", "s", "twilio", "inbound", AudioFormat("mulaw", 8000, 1), b"\xff" * 160, "stream_relative_ms", 0)


async def test_stt_receives_exactly_the_processed_frames() -> None:
    socket = FakeSocket()
    session = DeepgramStreamingSession(socket, PCM_16K)
    bridge = SttAudioBridge(AudioPipeline(target_sample_rate=16000, processors=[Invert()]), session, PCM_16K)
    await bridge.push(mulaw_frame())
    await bridge.push(mulaw_frame())
    await bridge.end()
    assert len(socket.binary) == 2
    assert all(len(b) == 640 and set(b) == {255} for b in socket.binary)
    assert socket.text == ['{"type": "CloseStream"}']


def test_bridge_rejects_format_mismatch() -> None:
    with pytest.raises(ProviderError):
        SttAudioBridge(AudioPipeline(target_sample_rate=8000), DeepgramStreamingSession(FakeSocket(), PCM_16K), PCM_16K)


async def test_session_rejects_wrong_format() -> None:
    with pytest.raises(ProviderError) as info:
        await DeepgramStreamingSession(FakeSocket(), PCM_16K).send_audio(mulaw_frame())
    assert info.value.code == "unsupported_format"


async def test_email_spoken_across_deepgram_segments() -> None:
    session = DeepgramStreamingSession(FakeSocket(), PCM_16K)
    for case in DEEPGRAM_CASES:
        if "message" in case and "expectError" not in case:
            session.receive(json.dumps(case["message"]))
    await session.close()
    reconciler = TranscriptReconciler("t1", "call-1", now=lambda: 0)
    capture = EmailCapture()
    results = []
    async for result in session.results():
        for event in reconciler.accept(result):
            results += await capture.handle(event)
    assert results == [
        {"type": "candidate", "email": "john.smith@gmail.com", "literal": False, "turnId": "turn-1", "replacesConfirmed": False}
    ]
