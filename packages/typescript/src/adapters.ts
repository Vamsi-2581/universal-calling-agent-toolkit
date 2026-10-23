// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vasik Mansuri
import { requireCapability, undeclaredCapabilities } from "./capabilities.js";
import { ProviderError } from "./errors.js";
import type {
  AdapterHealth,
  AudioFormat,
  CallSession,
  MediaDirection,
  ProviderCapabilities,
  TelephonyEvent,
} from "./types.js";

/** Resolves a secret at use time so credentials never live in config objects or logs. */
export type SecretResolver = () => Promise<string>;

export interface OperationOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/** Raw inbound HTTP request, exactly as received. Signature checks need the unparsed body and URL. */
export interface WebhookRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly rawBody: string;
}

export interface OutboundCallRequest {
  readonly to: string;
  readonly from: string;
  /** Provider-specific answer instructions (TwiML URL, Plivo answer URL, ...). Validated by the adapter. */
  readonly answer: Readonly<Record<string, unknown>>;
}

export interface TransferTarget {
  readonly to: string;
}

export interface MediaStreamRequest {
  readonly url: string;
  readonly tracks: readonly MediaDirection[];
  readonly bidirectional: boolean;
  readonly format?: AudioFormat;
  /** Provider-native options (e.g. Plivo noise_cancellation). Never confused with the toolkit's own audio pipeline. */
  readonly providerOptions?: Readonly<Record<string, unknown>>;
}

export interface MediaStreamHandle {
  readonly callId: string;
  readonly streamId: string;
}

/** Provider call control: REST APIs and webhooks. Unsupported operations must throw, never no-op. */
export interface CallControlAdapter {
  readonly provider: string;
  capabilities(): ProviderCapabilities;
  validateWebhook(req: WebhookRequest): Promise<void>;
  parseWebhook(req: WebhookRequest): Promise<TelephonyEvent[]>;
  startOutboundCall(req: OutboundCallRequest, opts?: OperationOptions): Promise<CallSession>;
  endCall(callId: string, opts?: OperationOptions): Promise<void>;
  transferCall(callId: string, target: TransferTarget, opts?: OperationOptions): Promise<void>;
  sendDtmf(callId: string, digits: string, opts?: OperationOptions): Promise<void>;
  startMediaStream(callId: string, req: MediaStreamRequest, opts?: OperationOptions): Promise<MediaStreamHandle>;
  stopMediaStream(callId: string, streamId: string, opts?: OperationOptions): Promise<void>;
  health(): Promise<AdapterHealth>;
}

/**
 * Base class whose every operation throws via requireCapability. Adapters override what they implement,
 * so a forgotten override surfaces as an explicit unsupported_capability error.
 */
export abstract class BaseCallControlAdapter implements CallControlAdapter {
  abstract readonly provider: string;
  abstract capabilities(): ProviderCapabilities;
  abstract health(): Promise<AdapterHealth>;

  async validateWebhook(_req: WebhookRequest): Promise<void> {
    this.notImplemented("webhook_validation");
  }
  async parseWebhook(_req: WebhookRequest): Promise<TelephonyEvent[]> {
    return this.notImplemented("call_status_events");
  }
  async startOutboundCall(_req: OutboundCallRequest): Promise<CallSession> {
    return this.notImplemented("outbound_calls");
  }
  async endCall(_callId: string): Promise<void> {
    this.notImplemented("end_call");
  }
  async transferCall(_callId: string, _target: TransferTarget): Promise<void> {
    this.notImplemented("call_transfer");
  }
  async sendDtmf(_callId: string, _digits: string): Promise<void> {
    this.notImplemented("dtmf_send");
  }
  async startMediaStream(_callId: string, _req: MediaStreamRequest): Promise<MediaStreamHandle> {
    return this.notImplemented("media_stream_control");
  }
  async stopMediaStream(_callId: string, _streamId: string): Promise<void> {
    this.notImplemented("media_stream_control");
  }

  private notImplemented(capability: Parameters<typeof requireCapability>[1]): never {
    requireCapability(this.capabilities(), capability);
    throw new ProviderError({
      code: "unsupported_capability",
      provider: this.provider,
      capability,
      message: `${this.provider} declares ${capability} as supported but does not implement it. This is an adapter bug.`,
    });
  }
}

/** The transport the consumer already owns (ws, uWebSockets, a gateway socket). The toolkit never opens servers itself. */
export interface MediaConnection {
  sendText(data: string): Promise<void>;
  /** Needed only by binary transports (raw PCM, RTP) that play audio back. */
  sendBinary?(data: Uint8Array): Promise<void>;
  close(code?: number, reason?: string): Promise<void>;
}

export interface StreamConnectionRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export interface MediaSessionOptions {
  /** Whether the host started the stream in bidirectional mode. Providers rarely say so in-band. */
  readonly bidirectional?: boolean;
  readonly maxQueuedEvents?: number;
  readonly maxPayloadBytes?: number;
  readonly maxMessageBytes?: number;
  readonly now?: () => number;
}

export type MediaSessionState = "awaiting_start" | "active" | "closing" | "closed";

export interface MediaSession {
  readonly provider: string;
  readonly state: MediaSessionState;
  /** null until the provider's start message arrives. */
  readonly callId: string | null;
  readonly sessionId: string | null;
  readonly inputFormat: AudioFormat | null;
  /** Audio frames dropped because the consumer fell behind. */
  readonly droppedAudioFrames: number;
  /** Effective capabilities for this stream, e.g. playback once it is known to be bidirectional. */
  capabilities(): ProviderCapabilities;
  /** Parses one provider message and enqueues normalized events. Throws ProviderError on malformed input. */
  receive(message: string | Uint8Array): void;
  events(): AsyncIterable<TelephonyEvent>;
  sendAudio(payload: Uint8Array, format: AudioFormat, opts?: OperationOptions): Promise<void>;
  sendMark(name: string, opts?: OperationOptions): Promise<void>;
  clearPlayback(opts?: OperationOptions): Promise<void>;
  sendDtmf(digits: string, opts?: OperationOptions): Promise<void>;
  close(reason?: string): Promise<void>;
}

/** Media transport: live audio in and out. Separate from call control by design. */
export interface MediaTransportAdapter {
  readonly provider: string;
  capabilities(): ProviderCapabilities;
  validateConnection(req: StreamConnectionRequest): Promise<void>;
  createSession(connection: MediaConnection, opts?: MediaSessionOptions): MediaSession;
}

/** A provider may offer call control, media, or both. null means "not available", not "not yet loaded". */
export interface TelephonyProvider {
  readonly name: string;
  readonly callControl: CallControlAdapter | null;
  readonly media: MediaTransportAdapter | null;
}

const LIVE_AUDIO: readonly Parameters<typeof requireCapability>[1][] = [
  "live_inbound_audio",
  "live_outbound_audio",
  "bidirectional_audio",
];

export class ProviderRegistry {
  private readonly providers = new Map<string, TelephonyProvider>();

  register(provider: TelephonyProvider): void {
    if (this.providers.has(provider.name)) {
      throw new ProviderError({
        code: "invalid_configuration",
        provider: provider.name,
        message: `A provider named ${provider.name} is already registered.`,
      });
    }
    if (!provider.callControl && !provider.media) {
      throw new ProviderError({
        code: "invalid_configuration",
        provider: provider.name,
        message: `${provider.name} has neither a call-control nor a media adapter.`,
      });
    }
    for (const adapter of [provider.callControl, provider.media]) {
      if (!adapter) continue;
      const caps = adapter.capabilities();
      const missing = undeclaredCapabilities(caps);
      if (missing.length > 0) {
        throw new ProviderError({
          code: "invalid_configuration",
          provider: provider.name,
          message: `${provider.name} adapter leaves capabilities undeclared: ${missing.join(", ")}.`,
        });
      }
      if (!provider.media) {
        const claimed = LIVE_AUDIO.filter((c) => caps.capabilities[c]?.support === "supported");
        if (claimed.length > 0) {
          throw new ProviderError({
            code: "invalid_configuration",
            provider: provider.name,
            message: `${provider.name} claims ${claimed.join(", ")} without a media transport adapter.`,
          });
        }
      }
    }
    this.providers.set(provider.name, provider);
  }

  get(name: string): TelephonyProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      const known = [...this.providers.keys()].join(", ") || "none";
      throw new ProviderError({
        code: "invalid_configuration",
        provider: name,
        message: `No provider named ${name} is registered (registered: ${known}).`,
      });
    }
    return provider;
  }

  names(): string[] {
    return [...this.providers.keys()];
  }
}
