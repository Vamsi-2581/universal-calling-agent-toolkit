# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Vasik Mansuri
"""Adapter contracts. Call control and media transport are separate by design."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal, NoReturn, Protocol, runtime_checkable

from .capabilities import require_capability, undeclared_capabilities
from .errors import ProviderError
from .types import (
    AdapterHealth,
    AudioFormat,
    CallSession,
    Capability,
    MediaDirection,
    ProviderCapabilities,
    TelephonyEvent,
)

if TYPE_CHECKING:
    from .media_session import MediaSessionOptions

#: Resolves a secret at use time so credentials never live in config objects or logs.
SecretResolver = Callable[[], Awaitable[str]]


@dataclass(frozen=True, slots=True)
class WebhookRequest:
    """Raw inbound HTTP request, exactly as received. Signature checks need the unparsed body and URL."""

    method: str
    url: str
    headers: Mapping[str, str]
    raw_body: str


@dataclass(frozen=True, slots=True)
class OutboundCallRequest:
    to: str
    from_: str
    #: Provider-specific answer instructions (TwiML URL, Plivo answer URL, ...). Validated by the adapter.
    answer: Mapping[str, Any]


@dataclass(frozen=True, slots=True)
class TransferTarget:
    to: str


@dataclass(frozen=True, slots=True)
class MediaStreamRequest:
    url: str
    tracks: Sequence[MediaDirection]
    bidirectional: bool
    format: AudioFormat | None = None
    #: Provider-native options (e.g. Plivo noise_cancellation). Never confused with the toolkit's own audio pipeline.
    provider_options: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class MediaStreamHandle:
    call_id: str
    stream_id: str


@dataclass(frozen=True, slots=True)
class StreamConnectionRequest:
    url: str
    headers: Mapping[str, str]


@runtime_checkable
class CallControlAdapter(Protocol):
    """Provider call control: REST APIs and webhooks. Unsupported operations must raise, never no-op."""

    @property
    def provider(self) -> str: ...
    def capabilities(self) -> ProviderCapabilities: ...
    async def validate_webhook(self, req: WebhookRequest) -> None: ...
    async def parse_webhook(self, req: WebhookRequest) -> list[TelephonyEvent]: ...
    async def start_outbound_call(self, req: OutboundCallRequest) -> CallSession: ...
    async def end_call(self, call_id: str) -> None: ...
    async def transfer_call(self, call_id: str, target: TransferTarget) -> None: ...
    async def send_dtmf(self, call_id: str, digits: str) -> None: ...
    async def start_media_stream(self, call_id: str, req: MediaStreamRequest) -> MediaStreamHandle: ...
    async def stop_media_stream(self, call_id: str, stream_id: str) -> None: ...
    async def health(self) -> AdapterHealth: ...


class BaseCallControlAdapter(ABC):
    """Every operation raises via require_capability. Adapters override what they implement,
    so a forgotten override surfaces as an explicit unsupported_capability error."""

    provider: str

    @abstractmethod
    def capabilities(self) -> ProviderCapabilities: ...

    @abstractmethod
    async def health(self) -> AdapterHealth: ...

    async def validate_webhook(self, req: WebhookRequest) -> None:
        self._not_implemented("webhook_validation")

    async def parse_webhook(self, req: WebhookRequest) -> list[TelephonyEvent]:
        self._not_implemented("call_status_events")

    async def start_outbound_call(self, req: OutboundCallRequest) -> CallSession:
        self._not_implemented("outbound_calls")

    async def end_call(self, call_id: str) -> None:
        self._not_implemented("end_call")

    async def transfer_call(self, call_id: str, target: TransferTarget) -> None:
        self._not_implemented("call_transfer")

    async def send_dtmf(self, call_id: str, digits: str) -> None:
        self._not_implemented("dtmf_send")

    async def start_media_stream(self, call_id: str, req: MediaStreamRequest) -> MediaStreamHandle:
        self._not_implemented("media_stream_control")

    async def stop_media_stream(self, call_id: str, stream_id: str) -> None:
        self._not_implemented("media_stream_control")

    def _not_implemented(self, capability: Capability) -> NoReturn:
        require_capability(self.capabilities(), capability)
        raise ProviderError(
            code="unsupported_capability",
            provider=self.provider,
            capability=capability,
            message=f"{self.provider} declares {capability} as supported but does not implement it. "
            "This is an adapter bug.",
        )


class MediaConnection(Protocol):
    """The transport the consumer already owns. The toolkit never opens servers itself."""

    async def send_text(self, data: str) -> None: ...
    async def close(self, code: int | None = None, reason: str | None = None) -> None: ...


MediaSessionState = Literal["awaiting_start", "active", "closing", "closed"]


class MediaSession(Protocol):
    @property
    def provider(self) -> str: ...
    @property
    def state(self) -> MediaSessionState: ...
    #: None until the provider's start message arrives.
    @property
    def call_id(self) -> str | None: ...
    @property
    def session_id(self) -> str | None: ...
    @property
    def input_format(self) -> AudioFormat | None: ...
    #: Audio frames dropped because the consumer fell behind.
    @property
    def dropped_audio_frames(self) -> int: ...
    def capabilities(self) -> ProviderCapabilities:
        """Effective capabilities for this stream, e.g. playback once it is known to be bidirectional."""
    def receive(self, message: str | bytes) -> None:
        """Parse one provider message and enqueue normalized events. Raise ProviderError on malformed input."""
    def events(self) -> AsyncIterator[TelephonyEvent]: ...
    async def send_audio(self, payload: bytes, fmt: AudioFormat) -> None: ...
    async def send_mark(self, name: str) -> None: ...
    async def clear_playback(self) -> None: ...
    async def send_dtmf(self, digits: str) -> None: ...
    async def close(self, reason: str | None = None) -> None: ...


class MediaTransportAdapter(Protocol):
    """Media transport: live audio in and out."""

    @property
    def provider(self) -> str: ...
    def capabilities(self) -> ProviderCapabilities: ...
    async def validate_connection(self, req: StreamConnectionRequest) -> None: ...
    def create_session(
        self, connection: MediaConnection, options: MediaSessionOptions | None = None
    ) -> MediaSession: ...


@dataclass(frozen=True, slots=True)
class TelephonyProvider:
    """A provider may offer call control, media, or both. None means "not available"."""

    name: str
    call_control: CallControlAdapter | None
    media: MediaTransportAdapter | None


_LIVE_AUDIO: tuple[Capability, ...] = ("live_inbound_audio", "live_outbound_audio", "bidirectional_audio")


class ProviderRegistry:
    def __init__(self) -> None:
        self._providers: dict[str, TelephonyProvider] = {}

    def register(self, provider: TelephonyProvider) -> None:
        name = provider.name
        if name in self._providers:
            raise ProviderError(
                code="invalid_configuration", provider=name, message=f"A provider named {name} is already registered."
            )
        adapters: list[CallControlAdapter | MediaTransportAdapter] = [
            a for a in (provider.call_control, provider.media) if a is not None
        ]
        if not adapters:
            raise ProviderError(
                code="invalid_configuration",
                provider=name,
                message=f"{name} has neither a call-control nor a media adapter.",
            )
        for adapter in adapters:
            caps = adapter.capabilities()
            missing = undeclared_capabilities(caps)
            if missing:
                raise ProviderError(
                    code="invalid_configuration",
                    provider=name,
                    message=f"{name} adapter leaves capabilities undeclared: {', '.join(missing)}.",
                )
            if provider.media is None:
                claimed = [c for c in _LIVE_AUDIO if caps.capabilities[c].support == "supported"]
                if claimed:
                    raise ProviderError(
                        code="invalid_configuration",
                        provider=name,
                        message=f"{name} claims {', '.join(claimed)} without a media transport adapter.",
                    )
        self._providers[name] = provider

    def get(self, name: str) -> TelephonyProvider:
        try:
            return self._providers[name]
        except KeyError:
            known = ", ".join(self._providers) or "none"
            raise ProviderError(
                code="invalid_configuration",
                provider=name,
                message=f"No provider named {name} is registered (registered: {known}).",
            ) from None

    def names(self) -> list[str]:
        return list(self._providers)
