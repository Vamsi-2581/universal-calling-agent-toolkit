# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Vasik Mansuri
"""End-to-end example: recording -> audio pipeline -> STT -> transcript -> email capture + RAG.

Run from packages/python:  uv run python ../../examples/python/end_to_end.py

A scripted STT session stands in for a real provider so this runs without an API key. Swap it for
DeepgramStreamingSession (calling_agent_toolkit.providers.deepgram) in a real deployment.
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
from collections.abc import AsyncIterator
from typing import Any

from calling_agent_toolkit import AudioFrame
from calling_agent_toolkit.audio_pipeline import AudioPipeline
from calling_agent_toolkit.email_capture import EmailCapture
from calling_agent_toolkit.rag import Chunk, InMemoryRetriever, Principal, RetrievalCoordinator, SafeRetriever, Source, format_context
from calling_agent_toolkit.stt import SttAudioBridge, SttResult, TranscriptReconciler
from calling_agent_toolkit.transports import file_frames, read_wav, write_wav_pcm16


class ScriptedSttSession:
    def __init__(self, results: list[SttResult]) -> None:
        self._results = results
        self.frames_received = 0
        self.bytes_received = 0

    async def send_audio(self, frame: AudioFrame) -> None:
        self.frames_received += 1
        self.bytes_received += len(frame.payload)

    async def finish(self) -> None: ...

    async def close(self) -> None: ...

    async def results(self) -> AsyncIterator[SttResult]:
        for result in self._results:
            yield result


async def main() -> None:
    # 1. A one-second 8 kHz recording (silence) stands in for call audio.
    wav = read_wav(write_wav_pcm16(bytes(8000 * 2), 8000))

    # 2. The same pipeline live calls use: decode, resample to 16 kHz, 20 ms frames, processors.
    pipeline = AudioPipeline(target_sample_rate=16000)
    stt = ScriptedSttSession([
        SttResult("segment_final", "my email is john dot smith at gmail dot com", 0.92, "0:2100", 0),
        SttResult("turn_end"),
        SttResult("segment_final", "what are your support hours", 0.95, "2500:1400", 2500),
        SttResult("turn_end"),
    ])
    bridge = SttAudioBridge(pipeline, stt, pipeline.target_format)
    for frame in file_frames(wav, call_id="demo-call", session_id="demo-call"):
        await bridge.push(frame)
    await bridge.end()

    # 3. Transcript reconciliation, email capture and retrieval.
    reconciler = TranscriptReconciler("acme", "demo-call")
    email = EmailCapture()
    kb = InMemoryRetriever()
    kb.upsert([
        Chunk(
            id="faq-hours",
            document_id="faq",
            tenant_id="acme",
            text="Support hours are 9am to 5pm, Monday to Friday.",
            source=Source("Support FAQ", "kb://faq#hours"),
        )
    ])
    rag = RetrievalCoordinator(SafeRetriever(kb), tenant_id="acme", principal=Principal("caller"))

    summary: dict[str, Any] = {"pipeline": dataclasses.asdict(pipeline.status()), "finals": [], "email": [], "rag": []}
    async for result in stt.results():
        for event in reconciler.accept(result):
            if event.kind == "final":
                summary["finals"].append(event.text)
            summary["email"] += await email.handle(event)
            context = await rag.handle(event)
            if context is not None:
                summary["rag"].append({
                    "status": context.status,
                    "citations": [i.citation.to_wire() for i in context.items],
                    "prompt": format_context(context),
                })
    summary["sttFramesReceived"] = stt.frames_received
    summary["sttBytesReceived"] = stt.bytes_received
    print("STT: scripted stand-in (no provider API was called)")
    print(json.dumps(summary, indent=2, default=str))


if __name__ == "__main__":
    asyncio.run(main())
