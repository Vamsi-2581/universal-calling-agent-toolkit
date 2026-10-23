# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Vasik Mansuri
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from calling_agent_toolkit import ProviderError
from calling_agent_toolkit.email_capture import TranscriptEvent
from calling_agent_toolkit.rag import (
    Chunk,
    InMemoryRetriever,
    LangChainRetriever,
    Principal,
    RetrievalCoordinator,
    RetrievalRequest,
    RetrievedChunk,
    SafeRetriever,
    format_context,
)

FIXTURE = json.loads((Path(__file__).resolve().parents[3] / "contracts/fixtures/rag/retrieval.json").read_text())
CHUNKS = [Chunk.from_wire(c) for c in FIXTURE["chunks"]]
BACKEND = InMemoryRetriever()
BACKEND.upsert(CHUNKS)
CALLER = Principal("caller")


def request_from(raw: dict[str, Any]) -> RetrievalRequest:
    p = raw["principal"]
    return RetrievalRequest(raw["tenantId"], Principal(p["id"], tuple(p["groups"])), raw["query"], raw.get("topK"), raw.get("filter"))


@pytest.mark.parametrize("case", FIXTURE["requests"], ids=lambda c: c["name"])
async def test_safe_retriever_fixtures(case: dict[str, Any]) -> None:
    ctx = await SafeRetriever(BACKEND).retrieve(request_from(case["request"]), "turn-1")
    expect = case["expect"]
    assert ctx.status == expect["status"]
    assert [i.citation.chunk_id for i in ctx.items] == expect["chunkIds"]
    assert ctx.dropped_for_access == expect["droppedForAccess"]
    assert all(i.untrusted for i in ctx.items)
    if "citations" in expect:
        assert [i.citation.to_wire() for i in ctx.items] == expect["citations"]
    if "formatted" in expect:
        assert format_context(ctx) == expect["formatted"]


def final(turn_id: str, text: str, kind: Any = "final") -> TranscriptEvent:
    return TranscriptEvent(turn_id, "t1", "s", turn_id, kind, text)


class Gated:
    """Backend that waits until released; optionally ignores cancellation."""

    def __init__(self, ignore_cancel: bool = False) -> None:
        self.gates: list[asyncio.Event] = []
        self.ignore_cancel = ignore_cancel

    async def retrieve(self, request: RetrievalRequest) -> list[RetrievedChunk]:
        gate = asyncio.Event()
        self.gates.append(gate)
        if self.ignore_cancel:
            await asyncio.shield(gate.wait())
        else:
            await gate.wait()
        return await BACKEND.retrieve(request)


async def test_coordinator_policy() -> None:
    coord = RetrievalCoordinator(SafeRetriever(BACKEND), tenant_id="t1", principal=CALLER)
    assert await coord.handle(final("u1", "what are your support hours", kind="partial")) is None
    assert await coord.handle(final("u1", "ok thanks")) is None
    ctx = await coord.handle(final("u2", "what are your support hours"))
    assert ctx is not None and ctx.status == "ok"
    assert await coord.handle(final("u3", "What are your support hours")) is None


async def test_newer_turn_cancels_older() -> None:
    backend = Gated()
    coord = RetrievalCoordinator(SafeRetriever(backend), tenant_id="t1", principal=CALLER)
    first = asyncio.create_task(coord.handle(final("u1", "what are your support hours")))
    while len(backend.gates) < 1:
        await asyncio.sleep(0)
    second = asyncio.create_task(coord.handle(final("u2", "how long do refunds take")))
    while len(backend.gates) < 2:
        await asyncio.sleep(0)
    backend.gates[1].set()
    a, b = await asyncio.gather(first, second)
    assert a is not None and a.status == "cancelled"
    assert b is not None and b.status == "empty"


async def test_stale_marking_is_deterministic() -> None:
    class Slow:
        def __init__(self) -> None:
            self.calls = 0

        async def retrieve(self, request: RetrievalRequest) -> list[RetrievedChunk]:
            self.calls += 1
            return await BACKEND.retrieve(request)

    class NoCancel(SafeRetriever):
        async def retrieve(self, request: RetrievalRequest, turn_id: str) -> Any:
            await gate.wait()
            return await super().retrieve(RetrievalRequest(request.tenant_id, request.principal, request.query), turn_id)

    gate = asyncio.Event()
    coord = RetrievalCoordinator(NoCancel(Slow()), tenant_id="t1", principal=CALLER)
    first = asyncio.create_task(coord.handle(final("u1", "what are your support hours")))
    await asyncio.sleep(0)
    second = asyncio.create_task(coord.handle(final("u2", "something about support hours")))
    await asyncio.sleep(0)
    gate.set()
    a, b = await asyncio.gather(first, second)
    assert a is not None and (a.status, a.items) == ("stale", ())
    assert b is not None and b.status == "ok"


async def test_timeout_and_errors() -> None:
    class Never:
        async def retrieve(self, request: RetrievalRequest) -> list[RetrievedChunk]:
            await asyncio.Event().wait()
            return []

    class Failing:
        async def retrieve(self, request: RetrievalRequest) -> list[RetrievedChunk]:
            raise ProviderError(code="provider_unavailable", provider="vectordb", message="down")

    req = RetrievalRequest("t1", CALLER, "x")
    assert (await SafeRetriever(Never(), timeout_s=0.01).retrieve(req, "u")).status == "timeout"
    ctx = await SafeRetriever(Failing()).retrieve(req, "u")
    assert ctx.status == "error" and ctx.error is not None
    assert (ctx.error["code"], ctx.error["retryable"]) == ("provider_unavailable", True)


async def test_ingestion_update_and_delete() -> None:
    kb = InMemoryRetriever()
    kb.upsert(CHUNKS)
    kb.delete_document("d4")
    kb.delete(["c1"])
    assert (await SafeRetriever(kb).retrieve(RetrievalRequest("t1", CALLER, "support hours"), "u")).status == "empty"


class Doc:
    def __init__(self, id: str, page_content: str, metadata: dict[str, Any]) -> None:
        self.id, self.page_content, self.metadata = id, page_content, metadata


async def test_langchain_shape_and_acl() -> None:
    class Fake:
        async def ainvoke(self, query: str) -> list[Doc]:
            return [
                Doc("a", "Support hours are 9 to 5", {"tenant_id": "t1", "document_id": "faq", "title": "FAQ", "source": "kb://faq"}),
                Doc("b", "Payroll data", {"tenant_id": "t1", "document_id": "hr", "acl_groups": ["hr"]}),
                Doc("c", "Other tenant", {"tenant_id": "t2", "document_id": "x"}),
            ]

    ctx = await SafeRetriever(LangChainRetriever(Fake())).retrieve(RetrievalRequest("t1", CALLER, "hours"), "u")
    assert [i.citation.to_wire() for i in ctx.items] == [
        {"id": "1", "chunkId": "a", "documentId": "faq", "title": "FAQ", "uri": "kb://faq", "page": None}
    ]
    assert ctx.dropped_for_access == 2


async def test_real_langchain_core_retriever() -> None:
    lc_docs = pytest.importorskip("langchain_core.documents")
    lc_retrievers = pytest.importorskip("langchain_core.retrievers")

    class StaticRetriever(lc_retrievers.BaseRetriever):  # type: ignore[misc, name-defined]
        def _get_relevant_documents(self, query: str, *, run_manager: Any) -> list[Any]:
            return [lc_docs.Document(page_content="Support hours are 9 to 5", metadata={"tenant_id": "t1", "document_id": "faq"}, id="a")]

    ctx = await SafeRetriever(LangChainRetriever(StaticRetriever())).retrieve(RetrievalRequest("t1", CALLER, "hours"), "u")
    assert [i.citation.chunk_id for i in ctx.items] == ["a"]
