// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vasik Mansuri
import type { MediaConnection, MediaSession, MediaSessionOptions, MediaSessionState, OperationOptions } from "./adapters.js";
import { frameToWire } from "./audio.js";
import { requireCapability } from "./capabilities.js";
import { ProviderError } from "./errors.js";
import { MessageReader, type JsonObject } from "./parse.js";
import { BoundedQueue } from "./queue.js";
import type {
  AudioFormat,
  Capability,
  CapabilityEntry,
  ProviderCapabilities,
  StreamStopReason,
  TelephonyEvent,
} from "./types.js";

export const DEFAULT_MAX_QUEUED_EVENTS = 500;
export const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;
export const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;

/**
 * Resolves capabilities that depend on how the stream was started. `undefined` keeps them at
 * requires_configuration so callers learn they must say whether the stream is bidirectional.
 */
export function resolveBidirectional(
  caps: ProviderCapabilities,
  dependent: readonly Capability[],
  bidirectional: boolean | undefined,
): ProviderCapabilities {
  if (bidirectional === undefined) return caps;
  const entry: CapabilityEntry = bidirectional
    ? { support: "supported" }
    : { support: "unsupported", note: "This stream was started unidirectional." };
  return {
    ...caps,
    capabilities: { ...caps.capabilities, ...Object.fromEntries(dependent.map((c) => [c, entry])) },
  };
}

/** Wire form of a TelephonyEvent, matching core.schema.json. */
export function eventToWire(event: TelephonyEvent): JsonObject {
  const base = { ...event, providerSequence: event.providerSequence ?? null };
  return event.type === "audio" ? { ...base, frame: frameToWire(event.frame) } : base;
}

/**
 * Shared lifecycle for JSON-over-WebSocket media protocols: state machine, bounded event queue,
 * size limits and outbound capability checks. Subclasses only translate provider messages.
 */
export abstract class BaseMediaSession implements MediaSession {
  state: MediaSessionState = "awaiting_start";
  callId: string | null = null;
  sessionId: string | null = null;
  inputFormat: AudioFormat | null = null;

  protected readonly reader: MessageReader;
  /** Name of the JSON field that carries the message type. */
  protected eventField = "event";
  protected readonly maxPayloadBytes: number;
  protected readonly bidirectional: boolean | undefined;
  private readonly maxMessageBytes: number;
  private readonly queue: BoundedQueue<TelephonyEvent>;
  private readonly now: () => number;
  private connectionClosed = false;
  private dropped = 0;
  private ignored = 0;

  constructor(
    readonly provider: string,
    private readonly connection: MediaConnection,
    private readonly baseCapabilities: ProviderCapabilities,
    private readonly bidirectionalDependent: readonly Capability[],
    options: MediaSessionOptions = {},
  ) {
    this.reader = new MessageReader(provider);
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    this.bidirectional = options.bidirectional;
    this.now = options.now ?? Date.now;
    this.queue = new BoundedQueue({
      capacity: options.maxQueuedEvents ?? DEFAULT_MAX_QUEUED_EVENTS,
      overflow: "reject",
      provider,
    });
  }

  capabilities(): ProviderCapabilities {
    return resolveBidirectional(this.baseCapabilities, this.bidirectionalDependent, this.bidirectional);
  }

  /** Audio frames discarded because the consumer fell behind. Control events are never dropped. */
  get droppedAudioFrames(): number {
    return this.dropped;
  }

  /** Well-formed messages with an event type this adapter does not know (forward compatibility). */
  get ignoredMessages(): number {
    return this.ignored;
  }

  events(): AsyncIterable<TelephonyEvent> {
    return this.queue;
  }

  receive(message: string | Uint8Array): void {
    if (this.state === "closed" || this.state === "closing") {
      throw new ProviderError({
        code: "session_closed",
        provider: this.provider,
        message: "The media session is closed.",
        ...this.ids(),
      });
    }
    const size = typeof message === "string" ? Buffer.byteLength(message) : message.byteLength;
    if (size > this.maxMessageBytes) {
      throw new ProviderError({
        code: "buffer_overflow",
        provider: this.provider,
        message: `Message of ${size} bytes exceeds the ${this.maxMessageBytes}-byte limit.`,
        ...this.ids(),
      });
    }
    this.handle(this.reader.json(message, this.eventField));
  }

  async close(reason?: string): Promise<void> {
    this.finish("socket_closed", null);
    if (this.connectionClosed) return;
    this.connectionClosed = true;
    await this.connection.close(1000, reason);
  }

  abstract sendAudio(payload: Uint8Array, format: AudioFormat, opts?: OperationOptions): Promise<void>;
  abstract sendMark(name: string, opts?: OperationOptions): Promise<void>;
  abstract clearPlayback(opts?: OperationOptions): Promise<void>;
  abstract sendDtmf(digits: string, opts?: OperationOptions): Promise<void>;

  protected abstract handle(message: JsonObject): void;

  protected requireActive(event: string): void {
    if (this.state !== "active") {
      throw new ProviderError({
        code: "protocol_violation",
        provider: this.provider,
        message: `Received "${event}" before the stream started.`,
      });
    }
  }

  protected requireSameStream(streamId: string | undefined): void {
    if (streamId !== undefined && streamId !== this.sessionId) {
      throw new ProviderError({
        code: "protocol_violation",
        provider: this.provider,
        message: `Message for stream ${streamId} arrived on session ${this.sessionId}.`,
        ...this.ids(),
      });
    }
  }

  protected begin(callId: string, sessionId: string, format: AudioFormat): void {
    if (this.state !== "awaiting_start") {
      throw new ProviderError({
        code: "protocol_violation",
        provider: this.provider,
        message: "Received a second start message.",
        ...this.ids(),
      });
    }
    this.callId = callId;
    this.sessionId = sessionId;
    this.inputFormat = format;
    this.state = "active";
  }

  protected eventBase(providerSequence: number | null) {
    return {
      provider: this.provider,
      callId: this.callId!,
      sessionId: this.sessionId!,
      receivedAtMs: this.now(),
      providerSequence,
    };
  }

  protected emit(event: TelephonyEvent): void {
    if (event.type === "audio") {
      try {
        this.queue.push(event);
      } catch (err) {
        if (!(err instanceof ProviderError) || err.code !== "buffer_overflow") throw err;
        this.dropped++;
      }
      return;
    }
    this.queue.push(event);
  }

  protected ignore(): void {
    this.ignored++;
  }

  protected finish(reason: StreamStopReason, providerSequence: number | null): void {
    if (this.state === "closed") return;
    if (this.state === "active") {
      try {
        this.queue.push({ type: "stream_stopped", reason, ...this.eventBase(providerSequence) });
      } catch {
        // Queue full: closing the queue still ends iteration, which signals the stop.
      }
    }
    this.state = "closed";
    this.queue.close();
  }

  /** Capability check, state check, then write. Nothing is sent when any check fails. */
  protected async sendJson(capability: Capability, message: JsonObject): Promise<void> {
    requireCapability(this.capabilities(), capability);
    if (this.state !== "active") {
      throw new ProviderError({
        code: this.state === "awaiting_start" ? "protocol_violation" : "session_closed",
        provider: this.provider,
        capability,
        message: this.state === "awaiting_start" ? "Cannot send before the stream starts." : "The media session is closed.",
        ...this.ids(),
      });
    }
    await this.connection.sendText(JSON.stringify(message));
  }

  protected invalid(message: string, capability?: Capability): ProviderError {
    return new ProviderError({
      code: "invalid_configuration",
      provider: this.provider,
      message,
      ...(capability !== undefined && { capability }),
      ...this.ids(),
    });
  }

  private ids(): { callId?: string; sessionId?: string } {
    return {
      ...(this.callId !== null && { callId: this.callId }),
      ...(this.sessionId !== null && { sessionId: this.sessionId }),
    };
  }
}
