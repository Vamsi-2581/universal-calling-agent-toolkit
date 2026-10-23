// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vasik Mansuri
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  InMemoryRetriever,
  LangChainRetrieverAdapter,
  ProviderError,
  RetrievalCoordinator,
  SafeRetriever,
  formatContext,
  type Retriever,
  type TranscriptEvent,
} from "../src/index.js";

const contracts = fileURLToPath(new URL("../../../contracts/", import.meta.url));
const fixture = JSON.parse(readFileSync(contracts + "fixtures/rag/retrieval.json", "utf8"));

const backend = new InMemoryRetriever();
backend.upsert(fixture.chunks);

describe("SafeRetriever fixtures", () => {
  for (const c of fixture.requests) {
    it(c.name, async () => {
      const ctx = await new SafeRetriever(backend).retrieve(c.request, "turn-1");
      expect(ctx.status).toBe(c.expect.status);
      expect(ctx.items.map((i) => i.citation.chunkId)).toEqual(c.expect.chunkIds);
      expect(ctx.droppedForAccess).toBe(c.expect.droppedForAccess);
      expect(ctx.items.every((i) => i.untrusted)).toBe(true);
      if (c.expect.citations) expect(ctx.items.map((i) => i.citation)).toEqual(c.expect.citations);
      if (c.expect.formatted) expect(formatContext(ctx)).toBe(c.expect.formatted);
    });
  }
});

const caller = { id: "caller", groups: [] };
const final = (turnId: string, text: string): TranscriptEvent => ({
  eventId: turnId, tenantId: "t1", sessionId: "s", turnId, kind: "final", revision: 0, text, confidence: null, receivedAtMs: 0,
});

/** Backend that waits until released. */
function gated() {
  const releases: Array<() => void> = [];
  const retriever: Retriever = {
    retrieve: (req) =>
      new Promise((resolve, reject) => {
        releases.push(() => resolve(backend.retrieve(req)));
        req.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  };
  return { retriever, release: (i: number) => releases[i]!() };
}

describe("RetrievalCoordinator", () => {
  it("ignores partials, short utterances and repeats", async () => {
    const coord = new RetrievalCoordinator(new SafeRetriever(backend), { tenantId: "t1", principal: caller });
    expect(await coord.handle({ ...final("u1", "what are your support hours"), kind: "partial" })).toBeNull();
    expect(await coord.handle(final("u1", "ok thanks"))).toBeNull();
    expect((await coord.handle(final("u2", "what are your support hours")))?.status).toBe("ok");
    expect(await coord.handle(final("u3", "What are your support hours"))).toBeNull();
  });

  it("cancels the older turn when a newer one arrives", async () => {
    const { retriever, release } = gated();
    const coord = new RetrievalCoordinator(new SafeRetriever(retriever), { tenantId: "t1", principal: caller });
    const first = coord.handle(final("u1", "what are your support hours"));
    const second = coord.handle(final("u2", "how long do refunds take"));
    release(1);
    expect((await first)?.status).toBe("cancelled");
    expect((await second)?.status).toBe("empty");
  });

  it("marks a late result for an older turn as stale with no items", async () => {
    // A retriever that cannot be cancelled: finishes after the newer turn has started.
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    class Uncancellable extends SafeRetriever {
      override async retrieve(req: Parameters<SafeRetriever["retrieve"]>[0], turnId: string) {
        await gate;
        const { signal: _ignored, ...rest } = req;
        return super.retrieve(rest, turnId);
      }
    }
    const coord = new RetrievalCoordinator(new Uncancellable(backend), { tenantId: "t1", principal: caller });
    const first = coord.handle(final("u1", "what are your support hours"));
    const second = coord.handle(final("u2", "something about support hours"));
    open();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ status: "stale", items: [] });
    expect(b?.status).toBe("ok");
  });

  it("reports timeouts and backend errors without throwing", async () => {
    const never: Retriever = { retrieve: () => new Promise(() => {}) };
    expect((await new SafeRetriever(never, { timeoutMs: 10 }).retrieve({ tenantId: "t1", principal: caller, query: "x" }, "u")).status).toBe(
      "timeout",
    );
    const failing: Retriever = {
      retrieve: async () => {
        throw new ProviderError({ code: "provider_unavailable", provider: "vectordb", message: "down" });
      },
    };
    const ctx = await new SafeRetriever(failing).retrieve({ tenantId: "t1", principal: caller, query: "x" }, "u");
    expect(ctx).toMatchObject({ status: "error", error: { code: "provider_unavailable", retryable: true } });
  });
});

describe("ingestion and LangChain adapter", () => {
  it("supports update and deletion", async () => {
    const kb = new InMemoryRetriever();
    kb.upsert(fixture.chunks);
    kb.deleteDocument("d4");
    kb.delete(["c1"]);
    const ctx = await new SafeRetriever(kb).retrieve({ tenantId: "t1", principal: caller, query: "support hours" }, "u");
    expect(ctx.status).toBe("empty");
  });

  it("maps LangChain documents and still enforces ACLs", async () => {
    const lc = {
      invoke: async () => [
        { id: "a", pageContent: "Support hours are 9 to 5", metadata: { tenant_id: "t1", document_id: "faq", title: "FAQ", source: "kb://faq" } },
        { id: "b", pageContent: "Payroll data", metadata: { tenant_id: "t1", document_id: "hr", acl_groups: ["hr"] } },
        { id: "c", pageContent: "Other tenant", metadata: { tenant_id: "t2", document_id: "x" } },
      ],
    };
    const ctx = await new SafeRetriever(new LangChainRetrieverAdapter(lc)).retrieve({ tenantId: "t1", principal: caller, query: "hours" }, "u");
    expect(ctx.items.map((i) => i.citation)).toEqual([{ id: "1", chunkId: "a", documentId: "faq", title: "FAQ", uri: "kb://faq", page: null }]);
    expect(ctx.droppedForAccess).toBe(2);
  });
});
