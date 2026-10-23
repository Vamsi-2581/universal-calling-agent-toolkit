// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vasik Mansuri
import { ProviderError } from "./errors.js";

/**
 * drop_oldest: keep realtime latency bounded by discarding stale items (audio).
 * reject: throw buffer_overflow so the producer can apply backpressure (control events).
 */
export type OverflowPolicy = "drop_oldest" | "reject";

export interface BoundedQueueOptions {
  readonly capacity: number;
  readonly overflow: OverflowPolicy;
  readonly provider?: string;
}

/** Single-consumer bounded async queue. close() ends iteration after draining. */
export class BoundedQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;
  private dropped = 0;

  constructor(private readonly options: BoundedQueueOptions) {
    if (!Number.isInteger(options.capacity) || options.capacity < 1) {
      throw new ProviderError({
        code: "invalid_configuration",
        provider: options.provider ?? "core",
        message: `Queue capacity must be a positive integer, got ${options.capacity}.`,
      });
    }
  }

  get size(): number {
    return this.items.length;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  push(item: T): void {
    if (this.closed) {
      throw new ProviderError({ code: "session_closed", provider: this.options.provider ?? "core", message: "Queue is closed." });
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
      return;
    }
    if (this.items.length >= this.options.capacity) {
      if (this.options.overflow === "reject") {
        throw new ProviderError({
          code: "buffer_overflow",
          provider: this.options.provider ?? "core",
          message: `Queue is full (capacity ${this.options.capacity}).`,
        });
      }
      this.items.shift();
      this.dropped++;
    }
    this.items.push(item);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length > 0) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
