// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vasik Mansuri
import { describe, expect, it } from "vitest";
import {
  BaseCallControlAdapter,
  BoundedQueue,
  CAPABILITIES,
  ProviderRegistry,
  type AdapterHealth,
  type Capability,
  type CapabilityEntry,
  type ProviderCapabilities,
} from "../src/index.js";

function allDeclared(overrides: Partial<Record<Capability, CapabilityEntry>> = {}): ProviderCapabilities {
  const capabilities = Object.fromEntries(CAPABILITIES.map((c) => [c, { support: "unsupported" }])) as Record<
    Capability,
    CapabilityEntry
  >;
  return { provider: "fake", adapterVersion: "0.0.0", capabilities: { ...capabilities, ...overrides } };
}

class FakeCallControl extends BaseCallControlAdapter {
  readonly provider = "fake";
  constructor(private readonly caps: ProviderCapabilities) {
    super();
  }
  capabilities() {
    return this.caps;
  }
  async health(): Promise<AdapterHealth> {
    return { provider: "fake", status: "healthy", checkedAtMs: 0 };
  }
}

describe("BoundedQueue", () => {
  it("drops the oldest item when full under drop_oldest", async () => {
    const q = new BoundedQueue<number>({ capacity: 2, overflow: "drop_oldest" });
    q.push(1);
    q.push(2);
    q.push(3);
    q.close();
    const seen: number[] = [];
    for await (const n of q) seen.push(n);
    expect(seen).toEqual([2, 3]);
    expect(q.droppedCount).toBe(1);
  });

  it("throws buffer_overflow under reject", () => {
    const q = new BoundedQueue<number>({ capacity: 1, overflow: "reject" });
    q.push(1);
    expect(() => q.push(2)).toThrow(expect.objectContaining({ code: "buffer_overflow" }));
  });

  it("hands items straight to a waiting consumer", async () => {
    const q = new BoundedQueue<string>({ capacity: 1, overflow: "reject" });
    const next = q[Symbol.asyncIterator]().next();
    q.push("a");
    expect(await next).toEqual({ value: "a", done: false });
  });

  it("rejects pushes after close and ends waiting consumers", async () => {
    const q = new BoundedQueue<number>({ capacity: 1, overflow: "reject" });
    const next = q[Symbol.asyncIterator]().next();
    q.close();
    expect(await next).toEqual({ value: undefined, done: true });
    expect(() => q.push(1)).toThrow(expect.objectContaining({ code: "session_closed" }));
  });

  it("validates capacity", () => {
    expect(() => new BoundedQueue({ capacity: 0, overflow: "reject" })).toThrow(
      expect.objectContaining({ code: "invalid_configuration" }),
    );
  });
});

describe("BaseCallControlAdapter", () => {
  it("raises unsupported_capability for operations the provider lacks", async () => {
    const adapter = new FakeCallControl(allDeclared());
    await expect(adapter.transferCall("c", { to: "+1" })).rejects.toMatchObject({
      code: "unsupported_capability",
      capability: "call_transfer",
    });
  });

  it("flags capabilities declared supported but not implemented", async () => {
    const adapter = new FakeCallControl(allDeclared({ end_call: { support: "supported" } }));
    await expect(adapter.endCall("c")).rejects.toThrow(/adapter bug/);
  });
});

describe("ProviderRegistry", () => {
  it("registers a fully declared provider and looks it up", () => {
    const registry = new ProviderRegistry();
    registry.register({ name: "fake", callControl: new FakeCallControl(allDeclared()), media: null });
    expect(registry.get("fake").callControl?.provider).toBe("fake");
  });

  it("rejects undeclared capabilities", () => {
    const partial: ProviderCapabilities = { provider: "fake", adapterVersion: "0", capabilities: {} };
    expect(() =>
      new ProviderRegistry().register({ name: "fake", callControl: new FakeCallControl(partial), media: null }),
    ).toThrow(/undeclared/);
  });

  it("rejects live audio claims without a media adapter", () => {
    const caps = allDeclared({ live_inbound_audio: { support: "supported" } });
    expect(() =>
      new ProviderRegistry().register({ name: "fake", callControl: new FakeCallControl(caps), media: null }),
    ).toThrow(/without a media transport adapter/);
  });

  it("names registered providers when lookup fails", () => {
    const registry = new ProviderRegistry();
    registry.register({ name: "fake", callControl: new FakeCallControl(allDeclared()), media: null });
    expect(() => registry.get("other")).toThrow(/registered: fake/);
  });
});
