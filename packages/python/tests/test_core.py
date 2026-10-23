from __future__ import annotations

import asyncio

import pytest

from calling_agent_toolkit import (
    CAPABILITIES,
    AdapterHealth,
    BaseCallControlAdapter,
    BoundedQueue,
    CapabilityEntry,
    ProviderCapabilities,
    ProviderError,
    ProviderRegistry,
    TelephonyProvider,
    TransferTarget,
)


def all_declared(**overrides: CapabilityEntry) -> ProviderCapabilities:
    caps = {c: CapabilityEntry("unsupported") for c in CAPABILITIES}
    caps.update(overrides)  # type: ignore[arg-type]
    return ProviderCapabilities(provider="fake", adapter_version="0.0.0", capabilities=caps)


class FakeCallControl(BaseCallControlAdapter):
    provider = "fake"

    def __init__(self, caps: ProviderCapabilities) -> None:
        self._caps = caps

    def capabilities(self) -> ProviderCapabilities:
        return self._caps

    async def health(self) -> AdapterHealth:
        return AdapterHealth(provider="fake", status="healthy", checked_at_ms=0)


async def test_queue_drops_oldest() -> None:
    q: BoundedQueue[int] = BoundedQueue(2, "drop_oldest")
    for n in (1, 2, 3):
        q.push(n)
    q.close()
    assert [n async for n in q] == [2, 3]
    assert q.dropped_count == 1


def test_queue_rejects_when_full() -> None:
    q: BoundedQueue[int] = BoundedQueue(1, "reject")
    q.push(1)
    with pytest.raises(ProviderError) as info:
        q.push(2)
    assert info.value.code == "buffer_overflow"


async def test_queue_wakes_waiting_consumer() -> None:
    q: BoundedQueue[str] = BoundedQueue(1, "reject")
    task = asyncio.create_task(anext(q))
    await asyncio.sleep(0)
    q.push("a")
    assert await task == "a"


async def test_queue_close_ends_waiters_and_rejects_pushes() -> None:
    q: BoundedQueue[int] = BoundedQueue(1, "reject")
    task = asyncio.create_task(anext(q))
    await asyncio.sleep(0)
    q.close()
    with pytest.raises(StopAsyncIteration):
        await task
    with pytest.raises(ProviderError) as info:
        q.push(1)
    assert info.value.code == "session_closed"


def test_queue_validates_capacity() -> None:
    with pytest.raises(ProviderError) as info:
        BoundedQueue(0, "reject")
    assert info.value.code == "invalid_configuration"


async def test_base_adapter_raises_for_missing_capability() -> None:
    with pytest.raises(ProviderError) as info:
        await FakeCallControl(all_declared()).transfer_call("c", TransferTarget("+1"))
    assert (info.value.code, info.value.capability) == ("unsupported_capability", "call_transfer")


async def test_base_adapter_flags_declared_but_unimplemented() -> None:
    adapter = FakeCallControl(all_declared(end_call=CapabilityEntry("supported")))
    with pytest.raises(ProviderError, match="adapter bug"):
        await adapter.end_call("c")


def test_registry_round_trip() -> None:
    registry = ProviderRegistry()
    registry.register(TelephonyProvider("fake", FakeCallControl(all_declared()), None))
    assert registry.get("fake").call_control is not None


def test_registry_rejects_undeclared_capabilities() -> None:
    partial = ProviderCapabilities(provider="fake", adapter_version="0", capabilities={})
    with pytest.raises(ProviderError, match="undeclared"):
        ProviderRegistry().register(TelephonyProvider("fake", FakeCallControl(partial), None))


def test_registry_rejects_live_audio_without_media() -> None:
    caps = all_declared(live_inbound_audio=CapabilityEntry("supported"))
    with pytest.raises(ProviderError, match="without a media transport adapter"):
        ProviderRegistry().register(TelephonyProvider("fake", FakeCallControl(caps), None))


def test_registry_lookup_names_registered() -> None:
    registry = ProviderRegistry()
    registry.register(TelephonyProvider("fake", FakeCallControl(all_declared()), None))
    with pytest.raises(ProviderError, match="registered: fake"):
        registry.get("other")
