from __future__ import annotations

from .errors import ProviderError
from .types import CAPABILITIES, Capability, ProviderCapabilities


def require_capability(caps: ProviderCapabilities, capability: Capability) -> None:
    """Raise ProviderError unless `capability` is declared "supported".

    Call this before every optional operation; never silently no-op.
    """
    entry = caps.capabilities.get(capability)
    if entry is None:
        raise ProviderError(
            code="unsupported_capability",
            provider=caps.provider,
            capability=capability,
            message=f"{capability} is not declared by the {caps.provider} adapter, so it is treated as unsupported.",
        )
    note = f" {entry.note}" if entry.note else ""
    if entry.support == "supported":
        return
    if entry.support == "requires_configuration":
        raise ProviderError(
            code="invalid_configuration",
            provider=caps.provider,
            capability=capability,
            message=f"{capability} needs additional configuration on {caps.provider}.{note}",
        )
    if entry.support == "unsupported":
        message = f"{capability} is not implemented by the {caps.provider} adapter.{note}"
    else:
        message = f"{capability} is not offered by {caps.provider}.{note}"
    raise ProviderError(code="unsupported_capability", provider=caps.provider, capability=capability, message=message)


def supports(caps: ProviderCapabilities, capability: Capability) -> bool:
    entry = caps.capabilities.get(capability)
    return entry is not None and entry.support == "supported"


def undeclared_capabilities(caps: ProviderCapabilities) -> list[Capability]:
    """Conformance rule: built-in adapters must declare every capability explicitly."""
    return [c for c in CAPABILITIES if c not in caps.capabilities]
