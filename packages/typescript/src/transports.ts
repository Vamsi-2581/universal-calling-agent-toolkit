/**
 * Provider-neutral transports for providers without a dedicated adapter:
 * - GenericJsonMediaTransport: configurable JSON-over-WebSocket parser (receive-only).
 * - RawPcmMediaSession: WebSockets that carry raw audio frames as binary messages.
 * - RTP (RFC 3550): parser, packetizer and session for SIP gateways, PBXs and Asterisk ExternalMedia.
 * - WAV: recordings for batch processing. Batch is never realtime.
 */
import type {
  MediaConnection,
  MediaSession,
  MediaSessionOptions,
  MediaSessionState,
  MediaTransportAdapter,
  StreamConnectionRequest,
} from "./adapters.js";
import { bytesPerSample, swapBytes16, validateAudioPayload } from "./audio.js";
import { requireCapability } from "./capabilities.js";
import { ProviderError } from "./errors.js";
import { BaseMediaSession, DEFAULT_MAX_PAYLOAD_BYTES, DEFAULT_MAX_QUEUED_EVENTS } from "./media-session.js";
import { isObject, type JsonObject } from "./parse.js";
import { BoundedQueue } from "./queue.js";
import {
  CAPABILITIES,
  SUPPORTED_SAMPLE_RATES,
  type AudioFormat,
  type AudioFrame,
  type Capability,
  type CapabilityEntry,
  type MediaDirection,
  type ProviderCapabilities,
  type TelephonyEvent,
  type TimestampKind,
} from "./types.js";

const ADAPTER_VERSION = "0.1.0";

function capabilities(provider: string, overrides: Partial<Record<Capability, CapabilityEntry>>): ProviderCapabilities {
  const base = Object.fromEntries(
    CAPABILITIES.map((c) => [c, { support: "unsupported", note: "Not offered by this generic transport." }]),
  ) as Record<Capability, CapabilityEntry>;
  return { provider, adapterVersion: ADAPTER_VERSION, capabilities: { ...base, ...overrides } };
}

function invalid(provider: string, message: string): ProviderError {
  return new ProviderError({ code: "invalid_configuration", provider, message });
}

const sameFormat = (a: AudioFormat, b: AudioFormat) =>
  a.encoding === b.encoding && a.sampleRate === b.sampleRate && a.channels === b.channels;

// ---------------------------------------------------------------------------------------------
// Generic JSON WebSocket

export interface GenericJsonConfig {
  readonly provider: string;
  /** JSON field holding the message type. Default "event". */
  readonly eventField?: string;
  readonly events: { readonly start: string; readonly media: string; readonly stop?: string };
  /** Dot paths into each message, e.g. "start.callSid" or "media.payload". */
  readonly paths: {
    readonly callId: string;
    readonly sessionId: string;
    readonly payload: string;
    readonly track?: string;
    readonly sequence?: string;
    readonly timestamp?: string;
  };
  /** The stream's audio format. Generic streams do not announce it in a standard way. */
  readonly format: AudioFormat;
  readonly timestampKind?: Exclude<TimestampKind, "none">;
  /** Provider track names mapped to directions. Default: inbound/outbound map to themselves. */
  readonly trackValues?: Readonly<Record<string, MediaDirection>>;
  readonly defaultTrack?: MediaDirection;
  /** Byte order of PCM payloads. Default little. */
  readonly pcmByteOrder?: "little" | "big";
}

function splitPath(path: string): { parent: string[]; key: string } {
  const parts = path.split(".");
  return { parent: parts.slice(0, -1), key: parts.at(-1)! };
}

function walk(obj: JsonObject, parts: readonly string[]): JsonObject | undefined {
  let cur: unknown = obj;
  for (const part of parts) {
    if (!isObject(cur)) return undefined;
    cur = cur[part];
  }
  return isObject(cur) ? cur : undefined;
}

/** Receive-only adapter for JSON streams whose shape is described by configuration. */
export class GenericJsonMediaTransport implements MediaTransportAdapter {
  readonly provider: string;

  constructor(
    private readonly config: GenericJsonConfig,
    private readonly options: { readonly connectionValidator?: (req: StreamConnectionRequest) => Promise<boolean> } = {},
  ) {
    this.provider = config.provider;
    if (!config.provider) throw invalid("generic_json", "provider name is required.");
    if (!config.events.start || !config.events.media) throw invalid(config.provider, "events.start and events.media are required.");
    if (!(SUPPORTED_SAMPLE_RATES as readonly number[]).includes(config.format.sampleRate)) {
      throw invalid(config.provider, `Unsupported sample rate ${config.format.sampleRate} Hz.`);
    }
  }

  capabilities(): ProviderCapabilities {
    return capabilities(this.provider, {
      live_inbound_audio: { support: "supported" },
      separate_tracks: this.config.paths.track ? { support: "supported" } : { support: "unsupported", note: "No track path configured." },
      playback: { support: "unsupported", note: "The generic JSON adapter is receive-only; write a provider adapter for playback." },
      stream_auth_validation: this.options.connectionValidator
        ? { support: "supported", note: "Uses the host-supplied connectionValidator." }
        : { support: "requires_configuration", note: "Pass connectionValidator." },
    });
  }

  async validateConnection(req: StreamConnectionRequest): Promise<void> {
    requireCapability(this.capabilities(), "stream_auth_validation");
    if (!(await this.options.connectionValidator!(req))) {
      throw new ProviderError({ code: "authentication_failed", provider: this.provider, message: "Stream connection was rejected." });
    }
  }

  createSession(connection: MediaConnection, options?: MediaSessionOptions): MediaSession {
    return new GenericJsonMediaSession(connection, this.capabilities(), this.config, options);
  }
}

class GenericJsonMediaSession extends BaseMediaSession {
  constructor(
    connection: MediaConnection,
    caps: ProviderCapabilities,
    private readonly config: GenericJsonConfig,
    options?: MediaSessionOptions,
  ) {
    super(config.provider, connection, caps, [], options);
    this.eventField = config.eventField ?? "event";
  }

  protected handle(msg: JsonObject): void {
    const c = this.config;
    const event = msg[this.eventField] as string;
    if (event === c.events.start) {
      if (this.state !== "awaiting_start") {
        throw new ProviderError({ code: "protocol_violation", provider: this.provider, message: "Received a second start message." });
      }
      this.begin(this.idAt(msg, c.paths.callId), this.idAt(msg, c.paths.sessionId), c.format);
      this.emit({
        type: "stream_started",
        ...this.eventBase(null),
        tracks: [c.defaultTrack ?? "inbound"],
        format: c.format,
        bidirectional: false,
      });
    } else if (event === c.events.media) {
      this.requireActive(event);
      const { parent, key } = splitPath(c.paths.payload);
      const holder = walk(msg, parent);
      if (!holder) throw this.reader.fail(`${c.paths.payload} is missing.`);
      let payload = this.reader.base64(holder, key, c.paths.payload);
      validateAudioPayload(c.format, payload.byteLength, this.maxPayloadBytes, this.provider);
      if (c.format.encoding === "pcm_s16le" && c.pcmByteOrder === "big") payload = swapBytes16(payload);
      const sequence = c.paths.sequence ? this.intAt(msg, c.paths.sequence) : null;
      const timestamp = c.paths.timestamp ? this.intAt(msg, c.paths.timestamp) : null;
      this.emit({
        type: "audio",
        ...this.eventBase(sequence),
        frame: {
          callId: this.callId!,
          sessionId: this.sessionId!,
          provider: this.provider,
          direction: this.trackAt(msg),
          format: c.format,
          payload,
          timestampMs: timestamp,
          timestampKind: timestamp === null ? "none" : (c.timestampKind ?? "stream_relative_ms"),
          sequenceNumber: sequence,
          chunk: null,
          isCompleteFrame: false,
        },
      });
    } else if (c.events.stop !== undefined && event === c.events.stop) {
      this.requireActive(event);
      this.finish("provider_stop", null);
    } else {
      this.ignore();
    }
  }

  async sendAudio(): Promise<void> {
    requireCapability(this.capabilities(), "playback");
  }
  async sendMark(): Promise<void> {
    requireCapability(this.capabilities(), "playback_marks");
  }
  async clearPlayback(): Promise<void> {
    requireCapability(this.capabilities(), "playback_interruption");
  }
  async sendDtmf(): Promise<void> {
    requireCapability(this.capabilities(), "dtmf_send");
  }

  private idAt(msg: JsonObject, path: string): string {
    const { parent, key } = splitPath(path);
    const holder = walk(msg, parent);
    if (!holder) throw this.reader.fail(`${path} is missing.`);
    return this.reader.id(holder, key, path);
  }

  private intAt(msg: JsonObject, path: string): number | null {
    const { parent, key } = splitPath(path);
    const holder = walk(msg, parent);
    return holder ? this.reader.optionalInt(holder, key, path) : null;
  }

  private trackAt(msg: JsonObject): MediaDirection {
    const c = this.config;
    if (!c.paths.track) return c.defaultTrack ?? "inbound";
    const { parent, key } = splitPath(c.paths.track);
    const holder = walk(msg, parent);
    const value = holder ? this.reader.optionalString(holder, key, c.paths.track) : undefined;
    if (value === undefined) return c.defaultTrack ?? "inbound";
    const mapped = c.trackValues?.[value] ?? (value === "inbound" || value === "outbound" ? value : undefined);
    if (mapped === undefined) throw this.reader.fail(`${c.paths.track} has unknown track "${value}".`);
    return mapped;
  }
}

// ---------------------------------------------------------------------------------------------
// Binary sessions (raw PCM, RTP)

export interface BinarySessionOptions {
  readonly callId: string;
  readonly sessionId: string;
  readonly direction?: MediaDirection;
  readonly maxQueuedEvents?: number;
  readonly maxPayloadBytes?: number;
  readonly now?: () => number;
}

/** Base for transports whose audio arrives as binary messages. Exported for provider adapters. */
export abstract class BinaryMediaSession implements MediaSession {
  state: MediaSessionState = "active";
  inputFormat: AudioFormat | null = null;
  readonly callId: string;
  readonly sessionId: string;
  protected readonly direction: MediaDirection;
  protected readonly maxPayloadBytes: number;
  protected readonly now: () => number;
  private readonly queue: BoundedQueue<TelephonyEvent>;
  private dropped = 0;
  private connectionClosed = false;

  constructor(
    readonly provider: string,
    protected readonly connection: MediaConnection,
    options: BinarySessionOptions,
  ) {
    if (!options.callId || !options.sessionId) throw invalid(provider, "callId and sessionId are required.");
    this.callId = options.callId;
    this.sessionId = options.sessionId;
    this.direction = options.direction ?? "inbound";
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.now = options.now ?? Date.now;
    this.queue = new BoundedQueue({ capacity: options.maxQueuedEvents ?? DEFAULT_MAX_QUEUED_EVENTS, overflow: "reject", provider });
  }

  abstract capabilities(): ProviderCapabilities;
  abstract receive(message: string | Uint8Array): void;
  abstract sendAudio(payload: Uint8Array, format: AudioFormat): Promise<void>;

  get droppedAudioFrames(): number {
    return this.dropped;
  }

  events(): AsyncIterable<TelephonyEvent> {
    return this.queue;
  }

  async sendMark(_name: string): Promise<void> {
    requireCapability(this.capabilities(), "playback_marks");
  }
  async clearPlayback(): Promise<void> {
    requireCapability(this.capabilities(), "playback_interruption");
  }
  async sendDtmf(_digits: string): Promise<void> {
    requireCapability(this.capabilities(), "dtmf_send");
  }

  async close(reason?: string): Promise<void> {
    if (this.state === "active" && this.inputFormat !== null) {
      try {
        this.queue.push({ type: "stream_stopped", ...this.base(null), reason: "socket_closed" });
      } catch {
        // full queue: closing still ends iteration
      }
    }
    this.state = "closed";
    this.queue.close();
    if (this.connectionClosed) return;
    this.connectionClosed = true;
    await this.connection.close(1000, reason);
  }

  protected requireOpen(): void {
    if (this.state !== "active") {
      throw new ProviderError({ code: "session_closed", provider: this.provider, message: "The media session is closed." });
    }
  }

  protected start(
    format: AudioFormat,
    extras: { readonly bidirectional?: boolean | null; readonly customParameters?: Readonly<Record<string, string>> } = {},
  ): void {
    this.inputFormat = format;
    this.queue.push({
      type: "stream_started",
      ...this.base(null),
      tracks: [this.direction],
      format,
      bidirectional: extras.bidirectional ?? null,
      ...(extras.customParameters !== undefined && { customParameters: extras.customParameters }),
    });
  }

  /** Control events are never dropped; a full queue raises buffer_overflow. */
  protected emitEvent(event: TelephonyEvent): void {
    this.queue.push(event);
  }

  protected base(providerSequence: number | null) {
    return { provider: this.provider, callId: this.callId, sessionId: this.sessionId, receivedAtMs: this.now(), providerSequence };
  }

  protected emitAudio(frame: AudioFrame, sequence: number | null): void {
    try {
      this.queue.push({ type: "audio", ...this.base(sequence), frame });
    } catch (err) {
      if (!(err instanceof ProviderError) || err.code !== "buffer_overflow") throw err;
      this.dropped++;
    }
  }
}

export interface RawPcmSessionOptions extends BinarySessionOptions {
  readonly provider?: string;
  readonly format: AudioFormat;
  /** Byte order of PCM on the wire. Default little. */
  readonly byteOrder?: "little" | "big";
  /** Playback needs this and a connection with sendBinary. */
  readonly bidirectional?: boolean;
  /** Text messages on the same socket (e.g. a JSON handshake). Ignored and counted when absent. */
  readonly onText?: (text: string) => void;
}

/** A WebSocket whose binary messages are raw audio in one known format. */
export class RawPcmMediaSession extends BinaryMediaSession {
  private readonly format: AudioFormat;
  private readonly byteOrder: "little" | "big";
  private readonly playable: boolean;
  private readonly onText: ((text: string) => void) | undefined;
  private samples = 0;
  private chunks = 0;
  private ignoredText = 0;

  constructor(connection: MediaConnection, options: RawPcmSessionOptions) {
    super(options.provider ?? "raw_pcm", connection, options);
    this.format = options.format;
    this.byteOrder = options.byteOrder ?? "little";
    this.playable = options.bidirectional === true && typeof connection.sendBinary === "function";
    this.onText = options.onText;
    this.start(options.format);
  }

  get ignoredMessages(): number {
    return this.ignoredText;
  }

  capabilities(): ProviderCapabilities {
    const playback: CapabilityEntry = this.playable
      ? { support: "supported" }
      : { support: "requires_configuration", note: "Pass bidirectional: true and a connection with sendBinary." };
    return capabilities(this.provider, { live_inbound_audio: { support: "supported" }, playback, bidirectional_audio: playback });
  }

  receive(message: string | Uint8Array): void {
    this.requireOpen();
    if (typeof message === "string") {
      if (this.onText) this.onText(message);
      else this.ignoredText++;
      return;
    }
    validateAudioPayload(this.format, message.byteLength, this.maxPayloadBytes, this.provider);
    const payload = this.format.encoding === "pcm_s16le" && this.byteOrder === "big" ? swapBytes16(message) : new Uint8Array(message);
    const timestampMs = (this.samples * 1000) / this.format.sampleRate;
    this.samples += payload.byteLength / bytesPerSample(this.format);
    this.emitAudio(
      {
        callId: this.callId,
        sessionId: this.sessionId,
        provider: this.provider,
        direction: this.direction,
        format: this.format,
        payload,
        timestampMs,
        timestampKind: "stream_relative_ms",
        sequenceNumber: null,
        chunk: this.chunks++,
        isCompleteFrame: false,
      },
      null,
    );
  }

  async sendAudio(payload: Uint8Array, format: AudioFormat): Promise<void> {
    requireCapability(this.capabilities(), "playback");
    this.requireOpen();
    if (!sameFormat(format, this.format)) {
      throw new ProviderError({ code: "unsupported_format", provider: this.provider, message: "Playback must use the stream's format." });
    }
    if (payload.byteLength === 0) throw invalid(this.provider, "Cannot play an empty payload.");
    await this.connection.sendBinary!(this.format.encoding === "pcm_s16le" && this.byteOrder === "big" ? swapBytes16(payload) : payload);
  }
}

// ---------------------------------------------------------------------------------------------
// RTP

export interface RtpPacket {
  readonly version: number;
  readonly padding: boolean;
  readonly extension: boolean;
  readonly csrcCount: number;
  readonly marker: boolean;
  readonly payloadType: number;
  readonly sequenceNumber: number;
  readonly timestamp: number;
  readonly ssrc: number;
  readonly payload: Uint8Array;
}

export function parseRtpPacket(bytes: Uint8Array, provider = "rtp"): RtpPacket {
  const fail = (message: string) => new ProviderError({ code: "malformed_message", provider, message });
  if (bytes.byteLength < 12) throw fail("RTP packet is shorter than its 12-byte header.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const b0 = bytes[0]!;
  const b1 = bytes[1]!;
  const version = b0 >> 6;
  if (version !== 2) throw fail(`RTP version ${version} is not supported.`);
  const padding = (b0 & 0x20) !== 0;
  const extension = (b0 & 0x10) !== 0;
  const csrcCount = b0 & 0x0f;
  let offset = 12 + csrcCount * 4;
  if (offset > bytes.byteLength) throw fail("RTP CSRC list runs past the packet.");
  if (extension) {
    if (offset + 4 > bytes.byteLength) throw fail("RTP header extension runs past the packet.");
    offset += 4 + view.getUint16(offset + 2) * 4;
    if (offset > bytes.byteLength) throw fail("RTP header extension runs past the packet.");
  }
  let end = bytes.byteLength;
  if (padding) {
    const count = bytes[end - 1]!;
    if (count === 0 || offset + count > end) throw fail("RTP padding is invalid.");
    end -= count;
  }
  return {
    version,
    padding,
    extension,
    csrcCount,
    marker: (b1 & 0x80) !== 0,
    payloadType: b1 & 0x7f,
    sequenceNumber: view.getUint16(2),
    timestamp: view.getUint32(4),
    ssrc: view.getUint32(8),
    payload: bytes.slice(offset, end),
  };
}

/** Builds RTP packets (no CSRC, extension or padding). Sequence and timestamp wrap as RFC 3550 requires. */
export class RtpPacketizer {
  private sequence: number;
  private timestamp: number;

  constructor(
    private readonly options: { readonly payloadType: number; readonly ssrc: number; readonly initialSequence?: number; readonly initialTimestamp?: number },
  ) {
    if (!Number.isInteger(options.payloadType) || options.payloadType < 0 || options.payloadType > 127) {
      throw invalid("rtp", "payloadType must be 0-127.");
    }
    this.sequence = (options.initialSequence ?? 0) & 0xffff;
    this.timestamp = (options.initialTimestamp ?? 0) >>> 0;
  }

  packetize(payload: Uint8Array, samples: number, marker = false): Uint8Array {
    const out = new Uint8Array(12 + payload.byteLength);
    const view = new DataView(out.buffer);
    out[0] = 0x80;
    out[1] = (marker ? 0x80 : 0) | this.options.payloadType;
    view.setUint16(2, this.sequence);
    view.setUint32(4, this.timestamp);
    view.setUint32(8, this.options.ssrc >>> 0);
    out.set(payload, 12);
    this.sequence = (this.sequence + 1) & 0xffff;
    this.timestamp = (this.timestamp + samples) >>> 0;
    return out;
  }
}

export interface RtpPayloadFormat {
  readonly format: AudioFormat;
  /** RTP L16 is network byte order (big-endian) per RFC 3551. */
  readonly byteOrder?: "little" | "big";
}

export interface RtpSessionOptions extends BinarySessionOptions {
  readonly provider?: string;
  /** Payload type -> format. Default {0: PCMU 8 kHz}. Static type 8 (PCMA) has no codec yet. */
  readonly payloadTypes?: Readonly<Record<number, RtpPayloadFormat>>;
  /** Enables sendAudio, which packetizes with this payload type and SSRC. Needs connection.sendBinary. */
  readonly playback?: { readonly payloadType: number; readonly ssrc: number };
}

const PCMU: RtpPayloadFormat = { format: { encoding: "mulaw", sampleRate: 8000, channels: 1 } };

/** RTP media from a gateway. The host owns the UDP socket and passes each datagram to receive(). */
export class RtpMediaSession extends BinaryMediaSession {
  private readonly payloadTypes: Readonly<Record<number, RtpPayloadFormat>>;
  private readonly packetizer: RtpPacketizer | null;
  private readonly playback: RtpSessionOptions["playback"];
  private ssrc: number | null = null;
  private lastSequence = 0;
  private firstTimestamp = 0;
  private packets = 0;
  private lost = 0;
  private late = 0;
  private ssrcChanges = 0;

  constructor(connection: MediaConnection, options: RtpSessionOptions) {
    super(options.provider ?? "rtp", connection, options);
    this.payloadTypes = options.payloadTypes ?? { 0: PCMU };
    this.playback = options.playback;
    if (options.playback && !this.payloadTypes[options.playback.payloadType]) {
      throw invalid(this.provider, `Playback payload type ${options.playback.payloadType} is not configured.`);
    }
    this.packetizer =
      options.playback && typeof connection.sendBinary === "function"
        ? new RtpPacketizer({ payloadType: options.playback.payloadType, ssrc: options.playback.ssrc })
        : null;
  }

  /** Packets missing from the sequence (gaps), late or duplicate packets dropped, and SSRC switches. */
  get stats() {
    return { packets: this.packets, lostPackets: this.lost, latePackets: this.late, ssrcChanges: this.ssrcChanges };
  }

  capabilities(): ProviderCapabilities {
    const playback: CapabilityEntry = this.packetizer
      ? { support: "supported" }
      : { support: "requires_configuration", note: "Pass playback {payloadType, ssrc} and a connection with sendBinary." };
    return capabilities(this.provider, { live_inbound_audio: { support: "supported" }, playback, bidirectional_audio: playback });
  }

  receive(message: string | Uint8Array): void {
    this.requireOpen();
    if (typeof message === "string") {
      throw new ProviderError({ code: "malformed_message", provider: this.provider, message: "RTP packets are binary." });
    }
    const packet = parseRtpPacket(message, this.provider);
    const mapping = this.payloadTypes[packet.payloadType];
    if (!mapping) {
      throw new ProviderError({
        code: "unsupported_format",
        provider: this.provider,
        message: `RTP payload type ${packet.payloadType} is not configured.`,
      });
    }
    if (this.inputFormat !== null && !sameFormat(mapping.format, this.inputFormat)) {
      throw new ProviderError({ code: "protocol_violation", provider: this.provider, message: "RTP payload format changed mid-stream." });
    }
    if (this.ssrc !== packet.ssrc) {
      if (this.ssrc !== null) this.ssrcChanges++;
      this.ssrc = packet.ssrc;
      this.lastSequence = (packet.sequenceNumber - 1) & 0xffff;
      if (this.inputFormat === null) this.firstTimestamp = packet.timestamp;
    }
    const delta = (packet.sequenceNumber - this.lastSequence) & 0xffff;
    if (delta === 0 || delta > 0x8000) {
      this.late++;
      return;
    }
    this.lost += delta - 1;
    this.lastSequence = packet.sequenceNumber;
    validateAudioPayload(mapping.format, packet.payload.byteLength, this.maxPayloadBytes, this.provider);
    if (this.inputFormat === null) this.start(mapping.format);
    const payload = mapping.format.encoding === "pcm_s16le" && mapping.byteOrder === "big" ? swapBytes16(packet.payload) : packet.payload;
    const elapsed = (packet.timestamp - this.firstTimestamp) >>> 0;
    this.emitAudio(
      {
        callId: this.callId,
        sessionId: this.sessionId,
        provider: this.provider,
        direction: this.direction,
        format: mapping.format,
        payload,
        timestampMs: (elapsed * 1000) / mapping.format.sampleRate,
        timestampKind: "stream_relative_ms",
        sequenceNumber: packet.sequenceNumber,
        chunk: this.packets++,
        isCompleteFrame: false,
      },
      packet.sequenceNumber,
    );
  }

  async sendAudio(payload: Uint8Array, format: AudioFormat): Promise<void> {
    requireCapability(this.capabilities(), "playback");
    this.requireOpen();
    const mapping = this.payloadTypes[this.playback!.payloadType]!;
    if (!sameFormat(format, mapping.format)) {
      throw new ProviderError({ code: "unsupported_format", provider: this.provider, message: "Playback must use the configured payload format." });
    }
    if (payload.byteLength === 0) throw invalid(this.provider, "Cannot play an empty payload.");
    const wire = format.encoding === "pcm_s16le" && mapping.byteOrder === "big" ? swapBytes16(payload) : payload;
    await this.connection.sendBinary!(this.packetizer!.packetize(wire, payload.byteLength / bytesPerSample(format)));
  }
}

// ---------------------------------------------------------------------------------------------
// WAV (batch / recordings)

export interface WavAudio {
  readonly format: AudioFormat;
  readonly data: Uint8Array;
}

const ascii = (b: Uint8Array, at: number) => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);

/** Reads PCM16, mu-law or A-law WAV. Unknown chunks are skipped; oversized data sizes are clamped. */
export function readWav(bytes: Uint8Array): WavAudio {
  const fail = (code: "malformed_message" | "unsupported_format", message: string) => new ProviderError({ code, provider: "wav", message });
  if (bytes.byteLength < 12 || ascii(bytes, 0) !== "RIFF" || ascii(bytes, 8) !== "WAVE") throw fail("malformed_message", "Not a RIFF/WAVE file.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format: AudioFormat | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > bytes.byteLength) throw fail("malformed_message", "fmt chunk is truncated.");
      let tag = view.getUint16(body, true);
      if (tag === 0xfffe && size >= 40 && body + 26 <= bytes.byteLength) tag = view.getUint16(body + 24, true);
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const bits = view.getUint16(body + 14, true);
      const encoding = tag === 1 && bits === 16 ? "pcm_s16le" : tag === 7 && bits === 8 ? "mulaw" : tag === 6 && bits === 8 ? "alaw" : null;
      if (encoding === null) throw fail("unsupported_format", `WAV format tag ${tag} with ${bits}-bit samples is not supported.`);
      if (channels < 1 || channels > 2) throw fail("unsupported_format", `${channels}-channel WAV is not supported.`);
      format = { encoding, sampleRate, channels };
    } else if (id === "data") {
      if (format === null) throw fail("malformed_message", "data chunk appears before fmt.");
      return { format, data: bytes.slice(body, Math.min(body + size, bytes.byteLength)) };
    }
    offset = body + size + (size & 1);
  }
  throw fail("malformed_message", "WAV file has no data chunk.");
}

/** Writes a 16-bit PCM WAV (for examples, fixtures and exporting processed audio). */
export function writeWavPcm16(pcm: Uint8Array, sampleRate: number, channels = 1): Uint8Array {
  const out = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(out.buffer);
  const put = (at: number, s: string) => [...s].forEach((ch, i) => (out[at + i] = ch.charCodeAt(0)));
  put(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  put(8, "WAVE");
  put(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  put(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}

/** Splits a recording into fixed frames that enter the same AudioPipeline as live audio. */
export function fileFrames(
  wav: WavAudio,
  options: { readonly callId: string; readonly sessionId: string; readonly provider?: string; readonly frameMs?: number; readonly direction?: MediaDirection },
): AudioFrame[] {
  const frameMs = options.frameMs ?? 20;
  const bytesPerFrame = (wav.format.sampleRate * frameMs * bytesPerSample(wav.format)) / 1000;
  if (!Number.isInteger(bytesPerFrame) || bytesPerFrame <= 0) throw invalid("file", `frameMs ${frameMs} does not divide the sample rate.`);
  const frames: AudioFrame[] = [];
  for (let i = 0, at = 0; at < wav.data.byteLength; i++, at += bytesPerFrame) {
    const payload = wav.data.slice(at, at + bytesPerFrame);
    frames.push({
      callId: options.callId,
      sessionId: options.sessionId,
      provider: options.provider ?? "file",
      direction: options.direction ?? "inbound",
      format: wav.format,
      payload,
      timestampMs: i * frameMs,
      timestampKind: "stream_relative_ms",
      sequenceNumber: null,
      chunk: i,
      isCompleteFrame: payload.byteLength === bytesPerFrame,
    });
  }
  return frames;
}
