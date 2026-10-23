from __future__ import annotations

from typing import Any, Literal, get_args

from .types import Capability

ProviderErrorCode = Literal[
    "unsupported_capability",
    "invalid_configuration",
    "authentication_failed",
    "signature_invalid",
    "malformed_message",
    "protocol_violation",
    "unsupported_format",
    "buffer_overflow",
    "session_closed",
    "provider_unavailable",
    "rate_limited",
    "timeout",
    "unknown",
]
PROVIDER_ERROR_CODES: tuple[ProviderErrorCode, ...] = get_args(ProviderErrorCode)

_RETRYABLE_BY_DEFAULT = frozenset({"provider_unavailable", "rate_limited", "timeout"})


class ProviderError(Exception):
    def __init__(
        self,
        *,
        code: ProviderErrorCode,
        message: str,
        provider: str,
        retryable: bool | None = None,
        capability: Capability | None = None,
        provider_code: str | None = None,
        call_id: str | None = None,
        session_id: str | None = None,
    ) -> None:
        super().__init__(message)
        self.code: ProviderErrorCode = code
        self.message = message
        self.provider = provider
        self.retryable = code in _RETRYABLE_BY_DEFAULT if retryable is None else retryable
        self.capability = capability
        self.provider_code = provider_code
        self.call_id = call_id
        self.session_id = session_id

    def to_dict(self) -> dict[str, Any]:
        """Serializable form, matching ProviderError in core.schema.json."""
        out: dict[str, Any] = {
            "code": self.code,
            "message": self.message,
            "provider": self.provider,
            "retryable": self.retryable,
        }
        optional = {
            "capability": self.capability,
            "providerCode": self.provider_code,
            "callId": self.call_id,
            "sessionId": self.session_id,
        }
        out.update({k: v for k, v in optional.items() if v is not None})
        return out
