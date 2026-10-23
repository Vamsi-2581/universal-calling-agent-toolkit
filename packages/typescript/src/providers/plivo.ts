// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vasik Mansuri
/**
 * Plivo adapters.
 * Audio Streams: https://www.plivo.com/docs/voice/api/audio-streams
 * Event protocol: https://www.plivo.com/docs/voice-agents/audio-streaming/concepts/stream-event-protocol
 * Signature V3 mirrors plivo-python plivo/utils/signature_v3.py.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  BaseCallControlAdapter,
  type MediaConnection,
  type MediaSessionOptions,
  type MediaStreamHandle,
  type MediaStreamRequest,
  type MediaTransportAdapter,
  type OperationOptions,
  type OutboundCallRequest,
  type SecretResolver,
  type StreamConnectionRequest,
  type TransferTarget,
  type WebhookRequest,
} from "../adapters.js";
import { swapBytes16, validateAudioPayload } from "../audio.js";
import { requireCapability } from "../capabilities.js";
import { ProviderError } from "../errors.js";
import { basicAuth, callApi, fetchHttpClient, jsonBody, type HttpClient, type HttpResponse } from "../http.js";
import { BaseMediaSession } from "../media-session.js";
import { DTMF_DIGIT, getHeader, type JsonObject } from "../parse.js";
import {
  SUPPORTED_SAMPLE_RATES,
  type AdapterHealth,
  type AudioFormat,
  type CallSession,
  type CallStatus,
  type Capability,
  type CapabilityEntry,
  type MediaDirection,
  type ProviderCapabilities,
  type TelephonyEvent,
} from "../types.js";

export const PLIVO = "plivo";
const ADAPTER_VERSION = "0.1.0";
/** playAudio accepts these rates per the Audio Streams API page. */
const PLAYBACK_RATES = [8000, 16000];

// ---------------------------------------------------------------------------------------------
// Signature V3

type Params = Map<string, string[]>;

/** Python unquote_plus: invalid escapes are kept as-is instead of throwing. */
function unquotePlus(s: string): string {
  return s.replace(/\+/g, " ").replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/** Mirrors Python parse_qs(keep_blank_values=True). */
function parseQs(query: string): Params {
  const out: Params = new Map();
  for (const part of query.split("&")) {
    if (part === "") continue;
    const eq = part.indexOf("=");
    const decode = unquotePlus;
    const key = decode(eq === -1 ? part : part.slice(0, eq));
    const value = eq === -1 ? "" : decode(part.slice(eq + 1));
    out.set(key, [...(out.get(key) ?? []), value]);
  }
  return out;
}

function splitUrl(url: string): { base: string; query: string } {
  const noFragment = url.split("#")[0] ?? "";
  const q = noFragment.indexOf("?");
  return q === -1 ? { base: noFragment, query: "" } : { base: noFragment.slice(0, q), query: noFragment.slice(q + 1) };
}

function sortedQuery(params: Params): string {
  return [...params.keys()]
    .sort()
    .map((k) => [...params.get(k)!].sort().map((v) => `${k}=${v}`).join("&"))
    .join("&");
}

function sortedParams(params: Params): string {
  return [...params.keys()]
    .sort()
    .map((k) => [...params.get(k)!].sort().map((v) => k + v).join(""))
    .join("");
}

function getBaseUrl(url: string, params: Params, emptyPostParams: boolean): string {
  const { base, query } = splitUrl(url);
  const merged: Params = new Map(params);
  for (const [k, v] of parseQs(query)) merged.set(k, v);
  const q = sortedQuery(merged);
  let out = base;
  if (q.length > 0 || !emptyPostParams) out += "?" + q;
  if (q.length > 0 && !emptyPostParams) out += ".";
  return out;
}

export function computePlivoSignatureV3(
  authToken: string,
  method: string,
  url: string,
  nonce: string,
  params: Params = new Map(),
): string {
  const base =
    method.toUpperCase() === "GET"
      ? getBaseUrl(url, params, true)
      : getBaseUrl(url, new Map(), params.size === 0) + sortedParams(params);
  return createHmac("sha256", authToken).update(`${base}.${nonce}`, "utf8").digest("base64");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Validates X-Plivo-Signature-V3 (comma-separated list allowed). Returns false rather than throwing. */
export function validatePlivoRequest(authToken: string, req: WebhookRequest): boolean {
  const header = getHeader(req.headers, "x-plivo-signature-v3");
  const nonce = getHeader(req.headers, "x-plivo-signature-v3-nonce");
  if (!header || !nonce) return false;
  const isForm = (getHeader(req.headers, "content-type") ?? "")
    .toLowerCase()
    .startsWith("application/x-www-form-urlencoded");
  const params = req.method.toUpperCase() === "POST" && isForm ? parseQs(req.rawBody) : new Map<string, string[]>();
  const expected = computePlivoSignatureV3(authToken, req.method, req.url, nonce, params);
  return header.split(",").some((candidate) => safeEqual(candidate, expected));
}

// ---------------------------------------------------------------------------------------------
// Capabilities

const CALL_CONTROL_ONLY: readonly Capability[] = [
  "inbound_calls",
  "outbound_calls",
  "answer_call",
  "end_call",
  "call_transfer",
  "call_status_events",
  "media_stream_control",
  "recording_access",
  "webhook_validation",
];
const MEDIA_ONLY: readonly Capability[] = [
  "dtmf_receive",
  "live_inbound_audio",
  "live_outbound_audio",
  "bidirectional_audio",
  "separate_tracks",
  "playback",
  "playback_marks",
  "playback_interruption",
  "stream_auth_validation",
  "provider_noise_suppression",
  "stream_recovery",
];
const BIDIRECTIONAL_DEPENDENT: readonly Capability[] = [
  "bidirectional_audio",
  "playback",
  "playback_marks",
  "playback_interruption",
  "dtmf_send",
];

const each = (caps: readonly Capability[], entry: CapabilityEntry) =>
  Object.fromEntries(caps.map((c) => [c, entry])) as Record<Capability, CapabilityEntry>;

const NEEDS_BIDIRECTIONAL: CapabilityEntry = {
  support: "requires_configuration",
  note: "Start the stream with bidirectional=true (inbound track only) and pass bidirectional: true when creating the session.",
};

function mediaCapabilities(hasValidator: boolean): ProviderCapabilities {
  const mulaw: AudioFormat = { encoding: "mulaw", sampleRate: 8000, channels: 1 };
  const l16 = [8000, 16000, 24000].map((sampleRate): AudioFormat => ({ encoding: "pcm_s16le", sampleRate, channels: 1 }));
  return {
    provider: PLIVO,
    adapterVersion: ADAPTER_VERSION,
    supportedInputFormats: [mulaw, ...l16],
    supportedPlaybackFormats: [mulaw, ...l16.filter((f) => PLAYBACK_RATES.includes(f.sampleRate))],
    capabilities: {
      ...each(CALL_CONTROL_ONLY, { support: "unsupported", note: "Call-control capability; see PlivoCallControl." }),
      dtmf_receive: { support: "supported" },
      live_inbound_audio: { support: "supported" },
      live_outbound_audio: { support: "supported", note: "audio_track=outbound or both; unidirectional streams only." },
      separate_tracks: { support: "supported" },
      bidirectional_audio: NEEDS_BIDIRECTIONAL,
      playback: NEEDS_BIDIRECTIONAL,
      playback_marks: NEEDS_BIDIRECTIONAL,
      playback_interruption: NEEDS_BIDIRECTIONAL,
      dtmf_send: NEEDS_BIDIRECTIONAL,
      stream_auth_validation: hasValidator
        ? { support: "supported", note: "Uses the host-supplied connectionValidator." }
        : {
            support: "requires_configuration",
            note: "Plivo does not document a signed WebSocket handshake. Pass connectionValidator, e.g. to check a secret you put in the stream URL.",
          },
      provider_noise_suppression: {
        support: "requires_configuration",
        note: "Set noise_cancellation when starting the stream. This is Plivo's own processing, separate from the toolkit's audio pipeline.",
      },
      stream_recovery: { support: "unsupported", note: "Plivo does not document resuming a stream after disconnect." },
    },
  };
}

function callControlCapabilities(): ProviderCapabilities {
  return {
    provider: PLIVO,
    adapterVersion: ADAPTER_VERSION,
    capabilities: {
      ...each(MEDIA_ONLY, { support: "unsupported", note: "Media capability; see PlivoMediaTransport." }),
      inbound_calls: { support: "supported", note: "Plivo requests your answer_url; respond with Plivo XML. parseWebhook normalizes callbacks." },
      outbound_calls: { support: "supported", note: "callId is Plivo's request_uuid; the call_uuid arrives in callbacks." },
      answer_call: { support: "unavailable_from_provider", note: "Calls are answered by returning XML from your answer_url." },
      end_call: { support: "supported" },
      call_transfer: { support: "supported", note: "Target is an https URL returning Plivo XML (A leg)." },
      call_status_events: { support: "supported" },
      media_stream_control: { support: "supported", note: "Audio Stream API, including provider-native noise_cancellation." },
      recording_access: { support: "unsupported", note: "Not implemented yet." },
      dtmf_send: { support: "supported" },
      webhook_validation: { support: "supported", note: "X-Plivo-Signature-V3 with nonce." },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Adapters

export interface PlivoCallControlOptions {
  /** Auth ID (not secret). */
  readonly authId: string;
  readonly authToken: SecretResolver;
  readonly http?: HttpClient;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

const PLIVO_STATUS: Readonly<Record<string, CallStatus>> = {
  queued: "queued",
  ringing: "ringing",
  "in-progress": "in_progress",
  completed: "completed",
  busy: "busy",
  failed: "failed",
  timeout: "no_answer",
  "no-answer": "no_answer",
  cancel: "canceled",
};
const STREAM_OPTIONS = new Set([
  "stream_timeout",
  "status_callback_url",
  "status_callback_method",
  "extra_headers",
  "noise_cancellation",
  "noise_cancellation_level",
]);
const seg = (s: string) => encodeURIComponent(s);

function invalid(message: string): ProviderError {
  return new ProviderError({ code: "invalid_configuration", provider: PLIVO, message });
}

/** Plivo REST call control (Call, DTMF and Audio Stream APIs) plus webhook validation and parsing. */
export class PlivoCallControl extends BaseCallControlAdapter {
  readonly provider = PLIVO;
  private readonly http: HttpClient;
  private readonly baseUrl: string;
  private readonly now: () => number;

  constructor(private readonly options: PlivoCallControlOptions) {
    super();
    if (!options.authId) throw invalid("authId is required.");
    this.http = options.http ?? fetchHttpClient;
    this.baseUrl = (options.baseUrl ?? "https://api.plivo.com").replace(/\/$/, "");
    this.now = options.now ?? Date.now;
  }

  capabilities(): ProviderCapabilities {
    return callControlCapabilities();
  }

  override async validateWebhook(req: WebhookRequest): Promise<void> {
    if (!validatePlivoRequest(await this.options.authToken(), req)) {
      throw new ProviderError({ code: "signature_invalid", provider: PLIVO, message: "X-Plivo-Signature-V3 did not match." });
    }
  }

  /** Parses a call callback. Call validateWebhook first; this method does not authenticate. */
  override async parseWebhook(req: WebhookRequest): Promise<TelephonyEvent[]> {
    const form = parseQs(req.rawBody);
    const callId = form.get("CallUUID")?.[0];
    const status = form.get("CallStatus")?.[0];
    if (!callId || !status) {
      throw new ProviderError({ code: "malformed_message", provider: PLIVO, message: "Callback needs CallUUID and CallStatus." });
    }
    return [
      {
        type: "call_status",
        provider: PLIVO,
        callId,
        sessionId: callId,
        receivedAtMs: this.now(),
        providerSequence: null,
        status: PLIVO_STATUS[status] ?? "unknown",
        providerStatus: status,
      },
    ];
  }

  override async startOutboundCall(req: OutboundCallRequest, opts?: OperationOptions): Promise<CallSession> {
    requireCapability(this.capabilities(), "outbound_calls");
    if (!req.to || !req.from) throw invalid("to and from are required.");
    const a = req.answer;
    if (typeof a["url"] !== "string") throw invalid("answer.url (Plivo answer_url) is required.");
    const body: JsonObject = { from: req.from, to: req.to, answer_url: a["url"] };
    if (typeof a["method"] === "string") body["answer_method"] = a["method"];
    if (typeof a["hangupUrl"] === "string") body["hangup_url"] = a["hangupUrl"];
    const res = jsonBody(PLIVO, await this.request("POST", "/Call/", body, opts));
    if (typeof res["request_uuid"] !== "string") throw this.unexpected("request_uuid");
    return { callId: res["request_uuid"], provider: PLIVO, direction: "outbound", status: "queued", from: req.from, to: req.to };
  }

  override async endCall(callId: string, opts?: OperationOptions): Promise<void> {
    requireCapability(this.capabilities(), "end_call");
    await this.request("DELETE", `/Call/${seg(callId)}/`, undefined, opts);
  }

  override async transferCall(callId: string, target: TransferTarget, opts?: OperationOptions): Promise<void> {
    requireCapability(this.capabilities(), "call_transfer");
    if (!/^https:\/\//.test(target.to)) throw invalid("Plivo transfers to an https URL that returns Plivo XML.");
    await this.request("POST", `/Call/${seg(callId)}/`, { legs: "aleg", aleg_url: target.to }, opts);
  }

  override async sendDtmf(callId: string, digits: string, opts?: OperationOptions): Promise<void> {
    requireCapability(this.capabilities(), "dtmf_send");
    if (!/^[0-9*#A-Da-d]+$/.test(digits)) throw invalid(`"${digits}" is not a DTMF digit string.`);
    await this.request("POST", `/Call/${seg(callId)}/DTMF/`, { digits }, opts);
  }

  override async startMediaStream(callId: string, req: MediaStreamRequest, opts?: OperationOptions): Promise<MediaStreamHandle> {
    requireCapability(this.capabilities(), "media_stream_control");
    if (!req.url.startsWith("wss://")) throw invalid("Stream url must start with wss://.");
    const tracks = new Set<string>(req.tracks);
    if (tracks.size === 0 || [...tracks].some((t) => t !== "inbound" && t !== "outbound")) {
      throw invalid("tracks must be inbound and/or outbound.");
    }
    const audioTrack = tracks.size === 2 ? "both" : [...tracks][0]!;
    if (req.bidirectional && audioTrack !== "inbound") throw invalid("Plivo bidirectional streams require tracks: [\"inbound\"].");
    const body: JsonObject = { service_url: req.url, bidirectional: req.bidirectional, audio_track: audioTrack };
    if (req.format) body["content_type"] = contentType(req.format);
    for (const [key, value] of Object.entries(req.providerOptions ?? {})) {
      if (!STREAM_OPTIONS.has(key)) throw invalid(`Unknown Plivo stream option ${key}.`);
      if (key === "noise_cancellation") {
        if (typeof value !== "boolean") throw invalid("noise_cancellation must be a boolean.");
        body[key] = value ? "true" : "false";
      } else if (key === "noise_cancellation_level") {
        if (typeof value !== "number" || !Number.isInteger(value) || value < 60 || value > 100) {
          throw invalid("noise_cancellation_level must be an integer from 60 to 100.");
        }
        body[key] = value;
      } else {
        body[key] = value;
      }
    }
    const res = jsonBody(PLIVO, await this.request("POST", `/Call/${seg(callId)}/Stream/`, body, opts));
    if (typeof res["stream_id"] !== "string") throw this.unexpected("stream_id");
    return { callId, streamId: res["stream_id"] };
  }

  override async stopMediaStream(callId: string, streamId: string, opts?: OperationOptions): Promise<void> {
    requireCapability(this.capabilities(), "media_stream_control");
    await this.request("DELETE", `/Call/${seg(callId)}/Stream/${seg(streamId)}/`, undefined, opts);
  }

  async health(): Promise<AdapterHealth> {
    return { provider: PLIVO, status: "healthy", checkedAtMs: Date.now(), detail: "Configuration only; no remote probe." };
  }

  private async request(method: "POST" | "DELETE", path: string, body: JsonObject | undefined, opts?: OperationOptions): Promise<HttpResponse> {
    const token = await this.options.authToken();
    const timeoutMs = opts?.timeoutMs ?? this.options.timeoutMs;
    const headers: Record<string, string> = { Authorization: basicAuth(this.options.authId, token), Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return callApi(
      PLIVO,
      this.http,
      {
        method,
        url: `${this.baseUrl}/v1/Account/${seg(this.options.authId)}${path}`,
        headers,
        ...(body !== undefined && { body: JSON.stringify(body) }),
      },
      { ...(timeoutMs !== undefined && { timeoutMs }), ...(opts?.signal && { signal: opts.signal }) },
    );
  }

  private unexpected(field: string): ProviderError {
    return new ProviderError({ code: "protocol_violation", provider: PLIVO, message: `Plivo response is missing ${field}.` });
  }
}

function contentType(format: AudioFormat): string {
  if (format.encoding === "mulaw" && format.sampleRate === 8000) return "audio/x-mulaw;rate=8000";
  if (format.encoding === "pcm_s16le" && [8000, 16000, 24000].includes(format.sampleRate)) return `audio/x-l16;rate=${format.sampleRate}`;
  throw new ProviderError({ code: "unsupported_format", provider: PLIVO, message: `Plivo streams do not offer ${format.encoding} at ${format.sampleRate} Hz.` });
}

export interface PlivoMediaTransportOptions {
  /** Host-defined handshake check. Plivo does not document a WebSocket signature. */
  readonly connectionValidator?: (req: StreamConnectionRequest) => Promise<boolean>;
}

export interface PlivoSessionOptions extends MediaSessionOptions {
  /**
   * Byte order of audio/x-l16 payloads. Plivo's docs do not state it, so L16 streams are refused
   * until you verify it against your account and set it here.
   */
  readonly l16ByteOrder?: "little" | "big";
}

export class PlivoMediaTransport implements MediaTransportAdapter {
  readonly provider = PLIVO;

  constructor(private readonly options: PlivoMediaTransportOptions = {}) {}

  capabilities(): ProviderCapabilities {
    return mediaCapabilities(this.options.connectionValidator !== undefined);
  }

  async validateConnection(req: StreamConnectionRequest): Promise<void> {
    requireCapability(this.capabilities(), "stream_auth_validation");
    if (!(await this.options.connectionValidator!(req))) {
      throw new ProviderError({ code: "authentication_failed", provider: PLIVO, message: "Stream connection was rejected." });
    }
  }

  createSession(connection: MediaConnection, options?: PlivoSessionOptions): PlivoMediaSession {
    return new PlivoMediaSession(connection, this.capabilities(), options);
  }
}

export class PlivoMediaSession extends BaseMediaSession {
  private readonly l16ByteOrder: "little" | "big" | undefined;

  constructor(connection: MediaConnection, capabilities: ProviderCapabilities, options: PlivoSessionOptions = {}) {
    super(PLIVO, connection, capabilities, BIDIRECTIONAL_DEPENDENT, options);
    this.l16ByteOrder = options.l16ByteOrder;
  }

  protected handle(msg: JsonObject): void {
    const r = this.reader;
    const event = msg["event"] as string;
    switch (event) {
      case "start": {
        if (this.state !== "awaiting_start") throw this.violation("Received a second start message.");
        const seq = r.optionalInt(msg, "sequenceNumber");
        const start = r.object(msg, "start");
        const callId = r.id(start, "callId", "start.callId");
        const streamId = r.id(start, "streamId", "start.streamId");
        const tracks = r.stringArray(start, "tracks", "start.tracks").map((t) => this.track(t, "start.tracks"));
        const mf = r.object(start, "mediaFormat", "start.mediaFormat");
        const format = this.format(
          r.string(mf, "encoding", "start.mediaFormat.encoding"),
          r.int(mf, "sampleRate", "start.mediaFormat.sampleRate"),
          r.optionalInt(mf, "channels", "start.mediaFormat.channels") ?? 1,
        );
        const extraHeaders = r.optionalString(msg, "extra_headers");
        this.begin(callId, streamId, format);
        this.emit({
          type: "stream_started",
          ...this.eventBase(seq),
          tracks,
          format,
          bidirectional: this.bidirectional ?? null,
          ...(extraHeaders ? { customParameters: { extraHeaders } } : {}),
        });
        return;
      }
      case "media": {
        this.requireActive(event);
        this.requireSameStream(r.optionalString(msg, "streamId"));
        const seq = r.optionalInt(msg, "sequenceNumber");
        const media = r.object(msg, "media");
        const direction = this.track(r.string(media, "track", "media.track"), "media.track");
        const timestamp = r.optionalInt(media, "timestamp", "media.timestamp");
        const chunk = r.optionalInt(media, "chunk", "media.chunk");
        let payload = r.base64(media, "payload", "media.payload");
        validateAudioPayload(this.inputFormat!, payload.byteLength, this.maxPayloadBytes, PLIVO);
        if (this.inputFormat!.encoding === "pcm_s16le" && this.l16ByteOrder === "big") payload = swapBytes16(payload);
        this.emit({
          type: "audio",
          ...this.eventBase(seq),
          frame: {
            callId: this.callId!,
            sessionId: this.sessionId!,
            provider: PLIVO,
            direction,
            format: this.inputFormat!,
            payload,
            timestampMs: timestamp,
            timestampKind: timestamp === null ? "none" : "unix_epoch_ms",
            sequenceNumber: seq,
            chunk,
            isCompleteFrame: false,
          },
        });
        return;
      }
      case "dtmf": {
        this.requireActive(event);
        this.requireSameStream(r.optionalString(msg, "streamId"));
        const seq = r.optionalInt(msg, "sequenceNumber");
        const dtmf = r.object(msg, "dtmf");
        const digit = r.string(dtmf, "digit", "dtmf.digit");
        if (!DTMF_DIGIT.test(digit)) throw r.fail("dtmf.digit must be a single DTMF character.");
        const track = r.optionalString(dtmf, "track", "dtmf.track");
        this.emit({
          type: "dtmf",
          ...this.eventBase(seq),
          digit,
          ...(track !== undefined && { direction: this.track(track, "dtmf.track") }),
        });
        return;
      }
      case "playedStream": {
        this.requireActive(event);
        this.requireSameStream(r.optionalString(msg, "streamId"));
        this.emit({ type: "playback_mark", ...this.eventBase(r.optionalInt(msg, "sequenceNumber")), name: r.string(msg, "name") });
        return;
      }
      case "clearedAudio":
        this.requireActive(event);
        this.requireSameStream(r.optionalString(msg, "streamId"));
        this.emit({ type: "playback_cleared", ...this.eventBase(r.optionalInt(msg, "sequenceNumber")) });
        return;
      case "stop":
        // Not in Plivo's WebSocket docs; handled defensively. Socket close is the documented end.
        this.requireActive(event);
        this.requireSameStream(r.optionalString(msg, "streamId"));
        this.finish("provider_stop", r.optionalInt(msg, "sequenceNumber"));
        return;
      default:
        this.ignore();
    }
  }

  async sendAudio(payload: Uint8Array, format: AudioFormat): Promise<void> {
    requireCapability(this.capabilities(), "playback");
    const input = this.inputFormat;
    if (
      input === null ||
      format.encoding !== input.encoding ||
      format.sampleRate !== input.sampleRate ||
      format.channels !== input.channels ||
      !PLAYBACK_RATES.includes(format.sampleRate)
    ) {
      throw new ProviderError({
        code: "unsupported_format",
        provider: PLIVO,
        capability: "playback",
        message: "Plivo playAudio must match the stream's content type and use 8000 or 16000 Hz.",
      });
    }
    if (payload.byteLength === 0) throw this.invalid("Cannot play an empty payload.", "playback");
    const wire = format.encoding === "pcm_s16le" && this.l16ByteOrder === "big" ? swapBytes16(payload) : payload;
    await this.sendJson("playback", {
      event: "playAudio",
      media: {
        contentType: format.encoding === "mulaw" ? "audio/x-mulaw" : "audio/x-l16",
        sampleRate: format.sampleRate,
        payload: Buffer.from(wire).toString("base64"),
      },
    });
  }

  async sendMark(name: string): Promise<void> {
    requireCapability(this.capabilities(), "playback_marks");
    if (name.length === 0) throw this.invalid("Checkpoint name must not be empty.", "playback_marks");
    await this.sendJson("playback_marks", { event: "checkpoint", streamId: this.sessionId, name });
  }

  async clearPlayback(): Promise<void> {
    await this.sendJson("playback_interruption", { event: "clearAudio", streamId: this.sessionId });
  }

  async sendDtmf(digits: string): Promise<void> {
    requireCapability(this.capabilities(), "dtmf_send");
    if (!/^[0-9*#A-Da-d]+$/.test(digits)) throw this.invalid(`"${digits}" is not a DTMF digit string.`, "dtmf_send");
    await this.sendJson("dtmf_send", { event: "sendDTMF", dtmf: digits });
  }

  private format(encoding: string, sampleRate: number, channels: number): AudioFormat {
    let mapped: AudioFormat["encoding"];
    if (encoding === "audio/x-mulaw") {
      mapped = "mulaw";
    } else if (encoding === "audio/x-l16") {
      if (this.l16ByteOrder === undefined) {
        throw this.invalid(
          "Plivo's docs do not state the byte order of audio/x-l16. Verify it with your account and pass l16ByteOrder, or start the stream with audio/x-mulaw.",
        );
      }
      mapped = "pcm_s16le";
    } else {
      throw new ProviderError({ code: "unsupported_format", provider: PLIVO, message: `Unsupported Plivo encoding ${encoding}.` });
    }
    if (!(SUPPORTED_SAMPLE_RATES as readonly number[]).includes(sampleRate)) {
      throw new ProviderError({ code: "unsupported_format", provider: PLIVO, message: `Unsupported sample rate ${sampleRate} Hz.` });
    }
    return { encoding: mapped, sampleRate, channels };
  }

  private track(value: string, path: string): MediaDirection {
    if (value === "inbound" || value === "outbound") return value;
    throw this.reader.fail(`${path} has unknown track "${value}".`);
  }

  private violation(message: string): ProviderError {
    return new ProviderError({ code: "protocol_violation", provider: PLIVO, message });
  }
}
