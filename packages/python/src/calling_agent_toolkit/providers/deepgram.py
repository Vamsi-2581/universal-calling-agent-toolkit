# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Vasik Mansuri
"""Deepgram live transcription (wss://api.deepgram.com/v1/listen).

Messages: https://developers.deepgram.com/docs/live-streaming-audio,
          https://developers.deepgram.com/docs/understanding-end-of-speech-detection
The host opens the WebSocket (with ``Authorization: Token <key>``) and passes it in as an SttConnection,
so API keys never pass through this module.
"""

from __future__ import annotations

import json
import math
from collections.abc import AsyncIterator
from typing import Any, Protocol
from urllib.parse import urlencode

from ..errors import ProviderError
from ..parse import MessageReader
from ..queue import BoundedQueue
from ..stt import SttCapabilities, SttResult
from ..types import AudioFormat, AudioFrame

DEEPGRAM = "deepgram"


class SttConnection(Protocol):
    async def send_binary(self, data: bytes) -> None: ...
    async def send_text(self, data: str) -> None: ...
    async def close(self) -> None: ...


def _encoding(fmt: AudioFormat) -> str:
    if fmt.encoding == "pcm_s16le":
        return "linear16"
    if fmt.encoding == "mulaw":
        return "mulaw"
    raise ProviderError(code="unsupported_format", provider=DEEPGRAM, message=f"No Deepgram encoding mapped for {fmt.encoding}.")


def deepgram_listen_url(
    fmt: AudioFormat,
    *,
    model: str | None = None,
    language: str | None = None,
    interim_results: bool = True,
    utterance_end_ms: int | None = None,
    endpointing_ms: int | None = None,
    smart_format: bool = False,
) -> str:
    """Build the listen URL for raw (headerless) audio. Requires interim results when utterance_end_ms is set."""
    if utterance_end_ms is not None and not interim_results:
        raise ProviderError(
            code="invalid_configuration",
            provider=DEEPGRAM,
            message="Deepgram requires interim_results=true when utterance_end_ms is used.",
        )
    params = {
        "encoding": _encoding(fmt),
        "sample_rate": str(fmt.sample_rate),
        "channels": str(fmt.channels),
        "interim_results": "true" if interim_results else "false",
    }
    if model:
        params["model"] = model
    if language:
        params["language"] = language
    if utterance_end_ms is not None:
        params["utterance_end_ms"] = str(utterance_end_ms)
    if endpointing_ms is not None:
        params["endpointing"] = str(endpointing_ms)
    if smart_format:
        params["smart_format"] = "true"
    return "wss://api.deepgram.com/v1/listen?" + urlencode(params)


def deepgram_capabilities() -> SttCapabilities:
    return SttCapabilities(
        provider=DEEPGRAM,
        interim_results=True,
        word_timestamps=True,
        confidence=True,
        diarization=False,
        input_formats=tuple(
            AudioFormat(enc, rate, 1) for rate in (8000, 16000, 24000, 48000) for enc in ("pcm_s16le", "mulaw")
        ),
    )


def _ms(seconds: float) -> int:
    return math.floor(seconds * 1000 + 0.5)


def parse_deepgram_message(message: str | dict[str, Any]) -> list[SttResult]:
    """Pure translation of one Deepgram server message. Unknown message types yield []."""
    r = MessageReader(DEEPGRAM)
    if isinstance(message, str):
        try:
            msg = json.loads(message)
        except ValueError:
            raise r.fail("Deepgram message is not a JSON object.") from None
        if not isinstance(msg, dict):
            raise r.fail("Deepgram message is not a JSON object.")
    else:
        msg = message
    if msg.get("type") == "UtteranceEnd":
        return [SttResult("turn_end")]
    if msg.get("type") != "Results":
        return []
    alternatives = r.object(msg, "channel").get("alternatives")
    if not isinstance(alternatives, list) or not alternatives or not isinstance(alternatives[0], dict):
        raise r.fail("channel.alternatives must be a non-empty array.")
    best = alternatives[0]
    text = r.string(best, "transcript", "channel.alternatives[0].transcript")
    conf = best.get("confidence")
    confidence = float(conf) if isinstance(conf, (int, float)) and not isinstance(conf, bool) else None
    if msg.get("is_final") is not True:
        return [SttResult("interim", text, confidence)]
    start, duration = msg.get("start"), msg.get("duration")
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in (start, duration)):
        raise r.fail("Final results need numeric start and duration.")
    assert isinstance(start, (int, float)) and isinstance(duration, (int, float))
    out = [SttResult("segment_final", text, confidence, f"{_ms(start)}:{_ms(duration)}", _ms(start))]
    if msg.get("speech_final") is True:
        out.append(SttResult("turn_end"))
    return out


class DeepgramStreamingSession:
    def __init__(self, connection: SttConnection, fmt: AudioFormat, *, max_queued_results: int = 1000) -> None:
        _encoding(fmt)
        self.format = fmt
        self._connection = connection
        self._queue: BoundedQueue[SttResult] = BoundedQueue(max_queued_results, "reject", DEEPGRAM)

    def receive(self, message: str) -> None:
        """Feed each text message from the Deepgram socket here."""
        for result in parse_deepgram_message(message):
            self._queue.push(result)

    async def send_audio(self, frame: AudioFrame) -> None:
        if frame.format != self.format:
            raise ProviderError(
                code="unsupported_format",
                provider=DEEPGRAM,
                message=f"Session expects {self.format.encoding}/{self.format.sample_rate}, "
                f"got {frame.format.encoding}/{frame.format.sample_rate}.",
            )
        await self._connection.send_binary(frame.payload)

    async def keep_alive(self) -> None:
        """Deepgram KeepAlive, for silences longer than its idle timeout."""
        await self._connection.send_text(json.dumps({"type": "KeepAlive"}))

    async def finish(self) -> None:
        await self._connection.send_text(json.dumps({"type": "CloseStream"}))

    def results(self) -> AsyncIterator[SttResult]:
        return self._queue

    async def close(self) -> None:
        self._queue.close()
        await self._connection.close()
