/**
 * Telnyx media streaming (WebSocket).
 * Protocol: https://developers.telnyx.com/docs/voice/programmable-voice/media-streaming
 * Telnyx does not document the unit of media.timestamp, so frames are ordered by chunk and carry no timestamp.
 * Call control (Telnyx Call Control API) is not implemented: register Telnyx with callControl: null.
 */
import type {
  MediaConnection,
  MediaSessionOptions,
  MediaTransportAdapter,
  StreamConnectionRequest,
} from "../adapters.js";
import { swapBytes16, validateAudioPayload } from "../audio.js";
import { requireCapability } from "../capabilities.js";
import { ProviderError, type ProviderErrorCode } from "../errors.js";
import { BaseMediaSession } from "../media-session.js";
import { DTMF_DIGIT, type JsonObject } from "../parse.js";
import {
  CAPABILITIES,
  SUPPORTED_SAMPLE_RATES,
  type AudioFormat,
  type Capability,
  type CapabilityEntry,
  type MediaDirection,
  type ProviderCapabilities,
} from "../types.js";

export const TELNYX = "telnyx";
const ADAPTER_VERSION = "0.1.0";

const ERROR_CODES: Readonly<Record<string, ProviderErrorCode>> = {
  "100002": "unknown",
  "100003": "malformed_message",
  "100004": "unsupported_format",
  "100005": "rate_limited",
};

const BIDIRECTIONAL_DEPENDENT: readonly Capability[] = ["bidirectional_audio", "playback", "playback_marks", "playback_interruption"];
const NEEDS_RTP_MODE: CapabilityEntry = {
  support: "requires_configuration",
  note: "Start the stream with stream_bidirectional_mode=rtp and pass bidirectional: true when creating the session.",
};

function mediaCapabilities(hasValidator: boolean): ProviderCapabilities {
  const base = Object.fromEntries(
    CAPABILITIES.map((c) => [c, { support: "unsupported", note: "Call-control capability; the Telnyx Call Control API is not implemented." }]),
  ) as Record<Capability, CapabilityEntry>;
  return {
    provider: TELNYX,
    adapterVersion: ADAPTER_VERSION,
    capabilities: {
      ...base,
      live_inbound_audio: { support: "supported" },
      live_outbound_audio: { support: "supported", note: "Set stream_track to outbound_track or both_tracks." },
      separate_tracks: { support: "supported" },
      dtmf_receive: { support: "supported" },
      dtmf_send: { support: "unavailable_from_provider", note: "The media stream has no DTMF message; use Call Control send_dtmf." },
      bidirectional_audio: NEEDS_RTP_MODE,
      playback: NEEDS_RTP_MODE,
      playback_marks: NEEDS_RTP_MODE,
      playback_interruption: NEEDS_RTP_MODE,
      stream_auth_validation: hasValidator
        ? { support: "supported", note: "Uses the host-supplied connectionValidator." }
        : { support: "requires_configuration", note: "Telnyx's streaming docs do not describe a handshake signature. Pass connectionValidator." },
      provider_noise_suppression: { support: "unsupported", note: "Not reviewed for this adapter." },
      stream_recovery: { support: "unsupported", note: "Not documented by Telnyx." },
    },
  };
}

export interface TelnyxSessionOptions extends MediaSessionOptions {
  /** Tracks requested with stream_track; the start message does not list them. Default ["inbound"]. */
  readonly tracks?: readonly MediaDirection[];
  /** Byte order of L16 payloads; Telnyx does not document it, so L16 is refused until set. */
  readonly l16ByteOrder?: "little" | "big";
}

export class TelnyxMediaTransport implements MediaTransportAdapter {
  readonly provider = TELNYX;

  constructor(private readonly options: { readonly connectionValidator?: (req: StreamConnectionRequest) => Promise<boolean> } = {}) {}

  capabilities(): ProviderCapabilities {
    return mediaCapabilities(this.options.connectionValidator !== undefined);
  }

  async validateConnection(req: StreamConnectionRequest): Promise<void> {
    requireCapability(this.capabilities(), "stream_auth_validation");
    if (!(await this.options.connectionValidator!(req))) {
      throw new ProviderError({ code: "authentication_failed", provider: TELNYX, message: "Stream connection was rejected." });
    }
  }

  createSession(connection: MediaConnection, options?: TelnyxSessionOptions): TelnyxMediaSession {
    return new TelnyxMediaSession(connection, this.capabilities(), options);
  }
}

export class TelnyxMediaSession extends BaseMediaSession {
  private readonly tracks: readonly MediaDirection[];
  private readonly l16ByteOrder: "little" | "big" | undefined;

  constructor(connection: MediaConnection, capabilities: ProviderCapabilities, options: TelnyxSessionOptions = {}) {
    super(TELNYX, connection, capabilities, BIDIRECTIONAL_DEPENDENT, options);
    this.tracks = options.tracks ?? ["inbound"];
    this.l16ByteOrder = options.l16ByteOrder;
  }

  protected handle(msg: JsonObject): void {
    const r = this.reader;
    const event = msg["event"] as string;
    switch (event) {
      case "connected":
        if (this.state !== "awaiting_start") throw this.violation("connected arrived after start.");
        return;
      case "start": {
        if (this.state !== "awaiting_start") throw this.violation("Received a second start message.");
        const seq = r.optionalInt(msg, "sequence_number");
        const streamId = r.id(msg, "stream_id");
        const start = r.object(msg, "start");
        const callId = r.id(start, "call_control_id", "start.call_control_id");
        const mf = r.object(start, "media_format", "start.media_format");
        const format = this.format(
          r.string(mf, "encoding", "start.media_format.encoding"),
          r.int(mf, "sample_rate", "start.media_format.sample_rate"),
          r.optionalInt(mf, "channels", "start.media_format.channels") ?? 1,
        );
        const custom: Record<string, string> = {};
        for (const [key, name] of [["from", "from"], ["to", "to"], ["client_state", "clientState"]] as const) {
          const value = r.optionalString(start, key, `start.${key}`);
          if (value !== undefined) custom[name] = value;
        }
        this.begin(callId, streamId, format);
        this.emit({
          type: "stream_started",
          ...this.eventBase(seq),
          tracks: this.tracks,
          format,
          bidirectional: this.bidirectional ?? null,
          ...(Object.keys(custom).length > 0 && { customParameters: custom }),
        });
        return;
      }
      case "media": {
        this.requireActive(event);
        this.requireSameStream(r.optionalString(msg, "stream_id"));
        const seq = r.optionalInt(msg, "sequence_number");
        const media = r.object(msg, "media");
        const track = r.string(media, "track", "media.track");
        if (track !== "inbound" && track !== "outbound") throw r.fail(`media.track has unknown track "${track}".`);
        const chunk = r.optionalInt(media, "chunk", "media.chunk");
        let payload = r.base64(media, "payload", "media.payload");
        validateAudioPayload(this.inputFormat!, payload.byteLength, this.maxPayloadBytes, TELNYX);
        if (this.inputFormat!.encoding === "pcm_s16le" && this.l16ByteOrder === "big") payload = swapBytes16(payload);
        this.emit({
          type: "audio",
          ...this.eventBase(seq),
          frame: {
            callId: this.callId!,
            sessionId: this.sessionId!,
            provider: TELNYX,
            direction: track,
            format: this.inputFormat!,
            payload,
            timestampMs: null,
            timestampKind: "none",
            sequenceNumber: seq,
            chunk,
            isCompleteFrame: false,
          },
        });
        return;
      }
      case "dtmf": {
        this.requireActive(event);
        this.requireSameStream(r.optionalString(msg, "stream_id"));
        const seq = r.optionalInt(msg, "sequence_number");
        const digit = r.string(r.object(msg, "dtmf"), "digit", "dtmf.digit");
        if (!DTMF_DIGIT.test(digit)) throw r.fail("dtmf.digit must be a single DTMF character.");
        this.emit({ type: "dtmf", ...this.eventBase(seq), digit, direction: "inbound" });
        return;
      }
      case "mark": {
        this.requireActive(event);
        this.requireSameStream(r.optionalString(msg, "stream_id"));
        const name = r.string(r.object(msg, "mark"), "name", "mark.name");
        this.emit({ type: "playback_mark", ...this.eventBase(r.optionalInt(msg, "sequence_number")), name });
        return;
      }
      case "error": {
        const payload = r.object(msg, "payload");
        const rawCode = payload["code"];
        const providerCode = typeof rawCode === "number" || typeof rawCode === "string" ? String(rawCode) : "unknown";
        const title = r.optionalString(payload, "title", "payload.title") ?? "error";
        const error = new ProviderError({
          code: ERROR_CODES[providerCode] ?? "unknown",
          provider: TELNYX,
          message: `Telnyx stream error ${providerCode}: ${title}`,
          providerCode,
          ...(this.callId !== null && { callId: this.callId }),
          ...(this.sessionId !== null && { sessionId: this.sessionId }),
        });
        if (this.state !== "active") throw error;
        this.emit({ type: "error", ...this.eventBase(null), error: error.toJSON() });
        return;
      }
      case "stop":
        this.requireActive(event);
        this.requireSameStream(r.optionalString(msg, "stream_id"));
        this.finish("provider_stop", r.optionalInt(msg, "sequence_number"));
        return;
      default:
        this.ignore();
    }
  }

  async sendAudio(payload: Uint8Array, format: AudioFormat): Promise<void> {
    requireCapability(this.capabilities(), "playback");
    const input = this.inputFormat;
    if (!input || format.encoding !== input.encoding || format.sampleRate !== input.sampleRate || format.channels !== input.channels) {
      throw new ProviderError({
        code: "unsupported_format",
        provider: TELNYX,
        capability: "playback",
        message: "Playback must match the stream's codec (stream_bidirectional_codec).",
      });
    }
    if (payload.byteLength === 0) throw this.invalid("Cannot play an empty payload.", "playback");
    const wire = format.encoding === "pcm_s16le" && this.l16ByteOrder === "big" ? swapBytes16(payload) : payload;
    await this.sendJson("playback", { event: "media", media: { payload: Buffer.from(wire).toString("base64") } });
  }

  async sendMark(name: string): Promise<void> {
    requireCapability(this.capabilities(), "playback_marks");
    if (name.length === 0) throw this.invalid("Mark name must not be empty.", "playback_marks");
    await this.sendJson("playback_marks", { event: "mark", mark: { name } });
  }

  async clearPlayback(): Promise<void> {
    await this.sendJson("playback_interruption", { event: "clear" });
  }

  async sendDtmf(): Promise<void> {
    requireCapability(this.capabilities(), "dtmf_send");
  }

  private format(encoding: string, sampleRate: number, channels: number): AudioFormat {
    let mapped: AudioFormat["encoding"];
    if (encoding === "PCMU") mapped = "mulaw";
    else if (encoding === "PCMA") mapped = "alaw";
    else if (encoding === "L16") {
      if (this.l16ByteOrder === undefined) {
        throw this.invalid("Telnyx does not document the byte order of L16 streams. Verify it and pass l16ByteOrder, or use PCMU.");
      }
      mapped = "pcm_s16le";
    } else {
      throw new ProviderError({ code: "unsupported_format", provider: TELNYX, message: `Unsupported Telnyx encoding ${encoding}.` });
    }
    if (!(SUPPORTED_SAMPLE_RATES as readonly number[]).includes(sampleRate)) {
      throw new ProviderError({ code: "unsupported_format", provider: TELNYX, message: `Unsupported sample rate ${sampleRate} Hz.` });
    }
    return { encoding: mapped, sampleRate, channels };
  }

  private violation(message: string): ProviderError {
    return new ProviderError({ code: "protocol_violation", provider: TELNYX, message });
  }
}
