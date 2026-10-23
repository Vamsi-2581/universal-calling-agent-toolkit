# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Vasik Mansuri
"""Provider-neutral speech-to-text contracts, plus the reconciler that turns provider results into
ordered, de-duplicated TranscriptEvents (the input of EmailCapture and the RAG coordinator)."""

from __future__ import annotations

import time
from collections.abc import AsyncIterator, Callable, Sequence
from dataclasses import dataclass
from typing import Any, Literal, Protocol

from .audio_pipeline import AudioPipeline
from .email_capture import TranscriptEvent
from .errors import ProviderError
from .types import AudioFormat, AudioFrame


@dataclass(frozen=True, slots=True)
class SttResult:
    """Normalized STT output. Confidence is None when the provider gives none."""

    type: Literal["interim", "segment_final", "turn_end"]
    text: str = ""
    confidence: float | None = None
    #: Provider-stable id for de-duplication (e.g. start:duration). segment_final only.
    segment_key: str | None = None
    start_ms: int | None = None

    def to_wire(self) -> dict[str, Any]:
        if self.type == "turn_end":
            return {"type": "turn_end"}
        out: dict[str, Any] = {"type": self.type, "text": self.text, "confidence": self.confidence}
        if self.type == "segment_final":
            out.update(segmentKey=self.segment_key, startMs=self.start_ms)
        return out

    @classmethod
    def from_wire(cls, data: dict[str, Any]) -> SttResult:
        return cls(
            type=data["type"],
            text=data.get("text", ""),
            confidence=data.get("confidence"),
            segment_key=data.get("segmentKey"),
            start_ms=data.get("startMs"),
        )


@dataclass(frozen=True, slots=True)
class SttCapabilities:
    provider: str
    interim_results: bool
    word_timestamps: bool
    confidence: bool
    diarization: bool
    input_formats: tuple[AudioFormat, ...]


class StreamingSttSession(Protocol):
    async def send_audio(self, frame: AudioFrame) -> None: ...
    async def finish(self) -> None: ...
    def results(self) -> AsyncIterator[SttResult]: ...
    async def close(self) -> None: ...


class StreamingSttAdapter(Protocol):
    provider: str

    def capabilities(self) -> SttCapabilities: ...
    async def open(self, fmt: AudioFormat, language: str | None = None) -> StreamingSttSession: ...


class BatchSttAdapter(Protocol):
    provider: str

    def capabilities(self) -> SttCapabilities: ...
    async def transcribe(self, audio: bytes, fmt: AudioFormat, language: str | None = None) -> list[SttResult]: ...


def transcript_to_wire(event: TranscriptEvent) -> dict[str, Any]:
    return {
        "eventId": event.event_id,
        "tenantId": event.tenant_id,
        "sessionId": event.session_id,
        "turnId": event.turn_id,
        "kind": event.kind,
        "revision": event.revision,
        "text": event.text,
        "confidence": event.confidence,
        "receivedAtMs": event.received_at_ms,
    }


@dataclass
class _Segment:
    text: str
    confidence: float | None
    start_ms: int | None
    order: int


class TranscriptReconciler:
    """Builds utterances from segment finals, shows interim text on top as partials, and emits exactly
    one final per turn. Interim text is never committed; duplicate segments are ignored."""

    def __init__(self, tenant_id: str, session_id: str, now: Callable[[], float] | None = None) -> None:
        self._tenant_id = tenant_id
        self._session_id = session_id
        self._now = now or (lambda: time.time() * 1000)
        self._turn = 1
        self._revision = 0
        self._seq = 0
        self._segments: dict[str, _Segment] = {}

    @property
    def turn_id(self) -> str:
        return f"turn-{self._turn}"

    def accept(self, result: SttResult) -> list[TranscriptEvent]:
        if result.type == "interim":
            text = result.text.strip()
            return [self._partial(" ".join([*self._committed(), text]))] if text else []
        if result.type == "segment_final":
            key = result.segment_key or ""
            if key in self._segments:
                return []
            text = result.text.strip()
            self._segments[key] = _Segment(text, result.confidence, result.start_ms, len(self._segments))
            return [self._partial(" ".join(self._committed()))] if text else []
        text = " ".join(self._committed())
        out: list[TranscriptEvent] = []
        if text:
            confidences = [s.confidence for s in self._segments.values() if s.text]
            confidence = min(c for c in confidences if c is not None) if all(c is not None for c in confidences) else None
            out.append(self._event("final", 0, text, confidence))
            self._turn += 1
        self._segments = {}
        self._revision = 0
        return out

    def _committed(self) -> list[str]:
        segs = [s for s in self._segments.values() if s.text]
        if all(s.start_ms is not None for s in segs):
            segs.sort(key=lambda s: (s.start_ms, s.order))
        else:
            segs.sort(key=lambda s: s.order)
        return [s.text for s in segs]

    def _partial(self, text: str) -> TranscriptEvent:
        event = self._event("partial", self._revision, text, None)
        self._revision += 1
        return event

    def _event(self, kind: Literal["partial", "final"], revision: int, text: str, confidence: float | None) -> TranscriptEvent:
        self._seq += 1
        return TranscriptEvent(
            event_id=f"{self._session_id}:{self.turn_id}:{self._seq}",
            tenant_id=self._tenant_id,
            session_id=self._session_id,
            turn_id=self.turn_id,
            kind=kind,
            text=text,
            revision=revision,
            confidence=confidence,
            received_at_ms=self._now(),
        )


class SttAudioBridge:
    """Connects the audio pipeline to an STT session so the provider receives exactly the processed
    frames. Rejects a format mismatch instead of silently transcoding again."""

    def __init__(self, pipeline: AudioPipeline, session: StreamingSttSession, stt_format: AudioFormat) -> None:
        if pipeline.target_format != stt_format:
            out = pipeline.target_format
            raise ProviderError(
                code="invalid_configuration",
                provider="stt",
                message=f"Pipeline produces {out.encoding}/{out.sample_rate}; the STT session expects "
                f"{stt_format.encoding}/{stt_format.sample_rate}.",
            )
        self._pipeline = pipeline
        self._session = session

    async def push(self, frame: AudioFrame) -> int:
        frames = self._pipeline.push(frame)
        for f in frames:
            await self._session.send_audio(f)
        return len(frames)

    async def end(self) -> None:
        for f in self._pipeline.flush():
            await self._session.send_audio(f)
        await self._session.finish()


def segments_text(results: Sequence[SttResult]) -> str:
    """Joined text of segment finals, for batch adapters that return whole recordings."""
    return " ".join(r.text.strip() for r in results if r.type == "segment_final" and r.text.strip())
