# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Vasik Mansuri
from __future__ import annotations

import asyncio
from collections import deque
from typing import Generic, Literal, TypeVar

from .errors import ProviderError

T = TypeVar("T")

#: drop_oldest: keep realtime latency bounded by discarding stale items (audio).
#: reject: raise buffer_overflow so the producer can apply backpressure (control events).
OverflowPolicy = Literal["drop_oldest", "reject"]


class BoundedQueue(Generic[T]):
    """Single-consumer bounded async queue. close() ends iteration after draining."""

    def __init__(self, capacity: int, overflow: OverflowPolicy, provider: str = "core") -> None:
        if not isinstance(capacity, int) or capacity < 1:
            raise ProviderError(
                code="invalid_configuration",
                provider=provider,
                message=f"Queue capacity must be a positive integer, got {capacity}.",
            )
        self._capacity = capacity
        self._overflow = overflow
        self._provider = provider
        self._items: deque[T] = deque()
        self._waiters: deque[asyncio.Future[None]] = deque()
        self._closed = False
        self._dropped = 0

    @property
    def size(self) -> int:
        return len(self._items)

    @property
    def dropped_count(self) -> int:
        return self._dropped

    @property
    def is_closed(self) -> bool:
        return self._closed

    def push(self, item: T) -> None:
        if self._closed:
            raise ProviderError(code="session_closed", provider=self._provider, message="Queue is closed.")
        if len(self._items) >= self._capacity:
            if self._overflow == "reject":
                raise ProviderError(
                    code="buffer_overflow",
                    provider=self._provider,
                    message=f"Queue is full (capacity {self._capacity}).",
                )
            self._items.popleft()
            self._dropped += 1
        self._items.append(item)
        self._wake_one()

    def close(self) -> None:
        self._closed = True
        while self._waiters:
            self._wake_one()

    def _wake_one(self) -> None:
        while self._waiters:
            waiter = self._waiters.popleft()
            if not waiter.done():
                waiter.set_result(None)
                return

    def __aiter__(self) -> BoundedQueue[T]:
        return self

    async def __anext__(self) -> T:
        while not self._items:
            if self._closed:
                raise StopAsyncIteration
            waiter: asyncio.Future[None] = asyncio.get_running_loop().create_future()
            self._waiters.append(waiter)
            await waiter
        return self._items.popleft()
