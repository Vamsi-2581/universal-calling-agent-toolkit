// Core types. The wire form of each type is defined in contracts/schemas/core.schema.json;
// keep the two in sync (contracts.test.ts checks the enums).

export const AUDIO_ENCODINGS = ["pcm_s16le", "mulaw", "alaw"] as const;
export type AudioEncoding = (typeof AUDIO_ENCODINGS)[number];

/** Sample rates the core pipeline accepts. Adapters must resample or reject anything else. */
export const SUPPORTED_SAMPLE_RATES = [8000, 16000, 24000, 48000] as const;

export interface AudioFormat {
  readonly encoding: AudioEncoding;
  readonly sampleRate: number;
  readonly channels: number;
}

/** inbound = from the remote party; outbound = toward the remote party. */
export type MediaDirection = "inbound" | "outbound";

/** Twilio timestamps are relative to stream start, Plivo's are Unix epoch. Never mix kinds. */
export type TimestampKind = "stream_relative_ms" | "unix_epoch_ms" | "none";

export interface AudioFrame {
  readonly callId: string;
  readonly sessionId: string;
  readonly provider: string;
  readonly direction: MediaDirection;
  readonly format: AudioFormat;
  readonly payload: Uint8Array;
  readonly timestampMs: number | null;
  readonly timestampKind: TimestampKind;
  readonly sequenceNumber: number | null;
  readonly chunk: number | null;
  /** false when the payload is a provider chunk that still needs re-framing. */
  readonly isCompleteFrame: boolean;
}

export const CAPABILITIES = [
  "inbound_calls",
  "outbound_calls",
  "answer_call",
  "end_call",
  "call_transfer",
  "call_status_events",
  "dtmf_receive",
  "dtmf_send",
  "media_stream_control",
  "live_inbound_audio",
  "live_outbound_audio",
  "bidirectional_audio",
  "separate_tracks",
  "playback",
  "playback_marks",
  "playback_interruption",
  "webhook_validation",
  "stream_auth_validation",
  "recording_access",
  "provider_noise_suppression",
  "stream_recovery",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export type CapabilitySupport =
  | "supported"
  | "unsupported"
  | "requires_configuration"
  | "unavailable_from_provider";

export interface CapabilityEntry {
  readonly support: CapabilitySupport;
  readonly note?: string;
}

export interface ProviderCapabilities {
  readonly provider: string;
  readonly adapterVersion: string;
  readonly supportedInputFormats?: readonly AudioFormat[];
  readonly supportedPlaybackFormats?: readonly AudioFormat[];
  readonly capabilities: Readonly<Partial<Record<Capability, CapabilityEntry>>>;
}

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

export interface AdapterHealth {
  readonly provider: string;
  readonly status: HealthStatus;
  readonly checkedAtMs: number;
  readonly activeSessions?: number;
  readonly detail?: string;
}

interface EventBase {
  readonly provider: string;
  readonly callId: string;
  readonly sessionId: string;
  readonly receivedAtMs: number;
  readonly providerSequence?: number | null;
}

export type StreamStopReason =
  | "provider_stop"
  | "call_ended"
  | "socket_closed"
  | "timeout"
  | "error"
  | "unknown";

export type CallStatus =
  | "queued"
  | "ringing"
  | "in_progress"
  | "completed"
  | "busy"
  | "no_answer"
  | "failed"
  | "canceled"
  | "unknown";

export type TelephonyEvent =
  | (EventBase & {
      readonly type: "stream_started";
      readonly tracks: readonly MediaDirection[];
      readonly format: AudioFormat;
      /** null when the provider does not report it in-band. */
      readonly bidirectional: boolean | null;
      readonly customParameters?: Readonly<Record<string, string>>;
    })
  | (EventBase & { readonly type: "audio"; readonly frame: AudioFrame })
  | (EventBase & { readonly type: "dtmf"; readonly digit: string; readonly direction?: MediaDirection })
  | (EventBase & { readonly type: "playback_mark"; readonly name: string })
  | (EventBase & { readonly type: "playback_cleared" })
  | (EventBase & { readonly type: "stream_stopped"; readonly reason: StreamStopReason })
  | (EventBase & { readonly type: "call_status"; readonly status: CallStatus; readonly providerStatus?: string })
  | (EventBase & { readonly type: "error"; readonly error: import("./errors.js").ProviderErrorData });

export type CallDirection = "inbound" | "outbound";

export interface CallSession {
  readonly callId: string;
  readonly provider: string;
  readonly direction: CallDirection;
  readonly status: CallStatus;
  readonly from?: string;
  readonly to?: string;
}
