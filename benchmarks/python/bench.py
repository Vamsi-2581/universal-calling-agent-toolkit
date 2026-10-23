# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Vasik Mansuri
"""Micro-benchmarks for the realtime path. Run from packages/python:

    uv run python ../../benchmarks/python/bench.py

Prints measured numbers only; results depend on the machine and are not a performance guarantee.
"""

from __future__ import annotations

import base64
import json
import platform
import sys
import time
from collections.abc import Callable
from typing import Any

from calling_agent_toolkit import AudioFormat, AudioFrame, decode_mulaw
from calling_agent_toolkit.audio_pipeline import AudioPipeline, LinearResampler, pcm16_to_samples
from calling_agent_toolkit.conformance import RecordingConnection
from calling_agent_toolkit.email_capture import extract_email
from calling_agent_toolkit.media_session import MediaSessionOptions
from calling_agent_toolkit.providers.twilio import TwilioMediaTransport


def bench(name: str, unit: str, iterations: int, fn: Callable[[int], Any]) -> dict[str, Any]:
    for i in range(min(1000, iterations)):  # warm-up
        fn(i)
    start = time.perf_counter_ns()
    for i in range(iterations):
        fn(i)
    ns = time.perf_counter_ns() - start
    return {"name": name, "unit": unit, "iterations": iterations, "perOpMicros": ns / iterations / 1000, "opsPerSecond": round(iterations * 1e9 / ns)}


FRAME = b"\x7f" * 160
MULAW = AudioFormat("mulaw", 8000, 1)


def mulaw_frame(i: int) -> AudioFrame:
    return AudioFrame("c", "s", "bench", "inbound", MULAW, FRAME, "stream_relative_ms", i * 20, i, i)


def main() -> None:
    results = [bench("G.711 mu-law decode", "20 ms frame (160 B)", 50_000, lambda i: decode_mulaw(FRAME))]
    resampler = LinearResampler(8000, 16000)
    samples = pcm16_to_samples(decode_mulaw(FRAME))
    results.append(bench("Resample 8 kHz -> 16 kHz", "20 ms frame", 50_000, lambda i: resampler.push(samples)))
    pipeline = AudioPipeline(target_sample_rate=16000)
    results.append(bench("AudioPipeline (decode+resample+frame)", "20 ms frame", 20_000, lambda i: pipeline.push(mulaw_frame(i))))

    session = TwilioMediaTransport().create_session(RecordingConnection(), MediaSessionOptions(max_queued_events=1))
    session.receive(json.dumps({
        "event": "start", "sequenceNumber": "1", "streamSid": "MZ1",
        "start": {"streamSid": "MZ1", "callSid": "CA1", "accountSid": "AC1", "tracks": ["inbound"],
                  "mediaFormat": {"encoding": "audio/x-mulaw", "sampleRate": 8000, "channels": 1}},
    }))
    payload = base64.b64encode(FRAME).decode()
    messages = [
        json.dumps({"event": "media", "sequenceNumber": str(i + 2), "streamSid": "MZ1",
                    "media": {"track": "inbound", "chunk": str(i + 1), "timestamp": str(i * 20), "payload": payload}})
        for i in range(1000)
    ]
    results.append(bench("Twilio media message -> AudioFrame", "message", 50_000, lambda i: session.receive(messages[i % 1000])))

    utterances = ["my email is john dot smith at gmail dot com", "what are your support hours on public holidays", "you can reach me at jane@example.org"]
    results.append(bench("extract_email", "utterance", 50_000, lambda i: extract_email(utterances[i % 3])))

    print(json.dumps({
        "runtime": f"python {sys.version.split()[0]}",
        "platform": f"{platform.system()} {platform.machine()}",
        "cpu": platform.processor() or "unknown",
        "results": results,
    }, indent=2))


if __name__ == "__main__":
    main()
