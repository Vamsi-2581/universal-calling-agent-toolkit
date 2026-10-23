"""Core types. Wire forms are defined in contracts/schemas/core.schema.json; keep the two in sync."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Literal, get_args

AudioEncoding = Literal["pcm_s16le", "mulaw", "alaw"]
AUDIO_ENCODINGS: tuple[AudioEncoding, ...] = get_args(AudioEncoding)

#: Sample rates the core pipeline accepts. Adapters must resample or reject anything else.
SUPPORTED_SAMPLE_RATES: tuple[int, ...] = (8000, 16000, 24000, 48000)

#: inbound = from the remote party; outbound = toward the remote party.
MediaDirection = Literal["inbound", "outbound"]

#: Twilio timestamps are relative to stream start, Plivo's are Unix epoch. Never mix kinds.
TimestampKind = Literal["stream_relative_ms", "unix_epoch_ms", "none"]

Capability = Literal[
    "inbound_calls",
    "outbound_calls",
    "answer_call",
    "end_call",
    "call_transfer",
    "call_status_events",
    "dtmf_receive",
    "dtmf_send",
    "media_stream_control",
    "live_inbound_audio",
    "live_outbound_audio",
    "bidirectional_audio",
    "separate_tracks",
    "playback",
    "playback_marks",
    "playback_interruption",
    "webhook_validation",
    "stream_auth_validation",
    "recording_access",
    "provider_noise_suppression",
    "stream_recovery",
]
CAPABILITIES: tuple[Capability, ...] = get_args(Capability)

CapabilitySupport = Literal["supported", "unsupported", "requires_configuration", "unavailable_from_provider"]
HealthStatus = Literal["healthy", "degraded", "unhealthy"]
CallDirection = Literal["inbound", "outbound"]
CallStatus = Literal[
    "queued", "ringing", "in_progress", "completed", "busy", "no_answer", "failed", "canceled", "unknown"
]
StreamStopReason = Literal["provider_stop", "call_ended", "socket_closed", "timeout", "error", "unknown"]
TelephonyEventType = Literal[
    "stream_started",
    "audio",
    "dtmf",
    "playback_mark",
    "playback_cleared",
    "stream_stopped",
    "call_status",
    "error",
]


@dataclass(frozen=True, slots=True)
class AudioFormat:
    encoding: AudioEncoding
    sample_rate: int
    channels: int = 1


@dataclass(frozen=True, slots=True)
class AudioFrame:
    call_id: str
    session_id: str
    provider: str
    direction: MediaDirection
    format: AudioFormat
    payload: bytes
    timestamp_kind: TimestampKind
    timestamp_ms: float | None = None
    sequence_number: int | None = None
    chunk: int | None = None
    #: False when the payload is a provider chunk that still needs re-framing.
    is_complete_frame: bool = False


@dataclass(frozen=True, slots=True)
class CapabilityEntry:
    support: CapabilitySupport
    note: str | None = None


@dataclass(frozen=True, slots=True)
class ProviderCapabilities:
    provider: str
    adapter_version: str
    capabilities: Mapping[Capability, CapabilityEntry]
    supported_input_formats: tuple[AudioFormat, ...] = ()
    supported_playback_formats: tuple[AudioFormat, ...] = ()

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> ProviderCapabilities:
        return cls(
            provider=data["provider"],
            adapter_version=data["adapterVersion"],
            capabilities={k: CapabilityEntry(v["support"], v.get("note")) for k, v in data["capabilities"].items()},
        )


@dataclass(frozen=True, slots=True)
class AdapterHealth:
    provider: str
    status: HealthStatus
    checked_at_ms: float
    active_sessions: int | None = None
    detail: str | None = None


@dataclass(frozen=True, slots=True)
class TelephonyEvent:
    """Normalized adapter event. `data` holds the type-specific fields defined by TelephonyEvent in the schema."""

    type: TelephonyEventType
    provider: str
    call_id: str
    session_id: str
    received_at_ms: float
    provider_sequence: int | None = None
    data: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class CallSession:
    call_id: str
    provider: str
    direction: CallDirection
    status: CallStatus
    from_: str | None = None
    to: str | None = None
