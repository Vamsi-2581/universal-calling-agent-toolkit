// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vasik Mansuri
/**
 * Twilio adapters.
 * Media Streams protocol: https://www.twilio.com/docs/voice/media-streams/websocket-messages
 * Signatures: https://www.twilio.com/docs/usage/webhooks/webhooks-security (mirrors twilio-python RequestValidator)
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
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
import { validateAudioPayload } from "../audio.js";
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

export const TWILIO = "twilio";
const ADAPTER_VERSION = "0.1.0";
const MULAW_8K: AudioFormat = { encoding: "mulaw", sampleRate: 8000, channels: 1 };

// ---------------------------------------------------------------------------------------------
// Signatures

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The URL as given plus its default-port twin; Twilio signs either form inconsistently. */
function portVariants(url: string): string[] {
  const match = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/is.exec(url);
  if (!match) return [url];
  const [, scheme = "", authority = "", rest = ""] = match;
  const port = /:(\d+)$/.exec(authority);
  if (port) return [url, scheme + authority.slice(0, port.index) + rest];
  const defaultPort = /^(https|wss):/i.test(scheme) ? 443 : 80;
  return [url, `${scheme}${authority}:${defaultPort}${rest}`];
}

function queryOf(url: string): URLSearchParams {
  const q = url.indexOf("?");
  return new URLSearchParams(q === -1 ? "" : url.slice(q + 1).split("#")[0]);
}

export type TwilioParams = ReadonlyMap<string, readonly string[]>;

/** HMAC-SHA1 over the URL followed by sorted, de-duplicated name+value pairs. */
export function computeTwilioSignature(authToken: string, url: string, params: TwilioParams = new Map()): string {
  let data = url;
  for (const name of [...params.keys()].sort()) {
    for (const value of [...new Set(params.get(name))].sort()) data += name + value;
  }
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

/** Validates a webhook or Media Streams handshake. Returns false rather than throwing. */
export function validateTwilioRequest(authToken: string, req: WebhookRequest): boolean {
  const signature = getHeader(req.headers, "x-twilio-signature");
  if (!signature) return false;
  const params = new Map<string, string[]>();
  const bodyHash = queryOf(req.url).get("bodySHA256");
  if (bodyHash !== null) {
    if (!safeEqual(createHash("sha256").update(req.rawBody, "utf8").digest("hex"), bodyHash)) return false;
  } else if (
    req.method.toUpperCase() === "POST" &&
    (getHeader(req.headers, "content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")
  ) {
    for (const [name, value] of new URLSearchParams(req.rawBody)) {
      params.set(name, [...(params.get(name) ?? []), value]);
    }
  }
  return portVariants(req.url).some((url) => safeEqual(computeTwilioSignature(authToken, url, params), signature));
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
  "stream_recovery",
];
const BIDIRECTIONAL_DEPENDENT: readonly Capability[] = [
  "bidirectional_audio",
  "playback",
  "playback_marks",
  "playback_interruption",
  "dtmf_receive",
];

const each = (caps: readonly Capability[], entry: CapabilityEntry) =>
  Object.fromEntries(caps.map((c) => [c, entry])) as Record<Capability, CapabilityEntry>;

const NEEDS_CONNECT: CapabilityEntry = {
  support: "requires_configuration",
  note: "Requires a bidirectional <Connect><Stream>; pass bidirectional: true when creating the session.",
};

function mediaCapabilities(hasAuthToken: boolean): ProviderCapabilities {
  return {
    provider: TWILIO,
    adapterVersion: ADAPTER_VERSION,
    supportedInputFormats: [MULAW_8K],
    supportedPlaybackFormats: [MULAW_8K],
    capabilities: {
      ...each(CALL_CONTROL_ONLY, { support: "unsupported", note: "Call-control capability; see TwilioCallControl." }),
      live_inbound_audio: { support: "supported" },
      live_outbound_audio: { support: "supported", note: 'Requires track="outbound_track" or "both_tracks" on <Start><Stream>.' },
      separate_tracks: { support: "supported" },
      bidirectional_audio: NEEDS_CONNECT,
      playback: NEEDS_CONNECT,
      playback_marks: NEEDS_CONNECT,
      playback_interruption: NEEDS_CONNECT,
      dtmf_receive: NEEDS_CONNECT,
      dtmf_send: { support: "unavailable_from_provider", note: "Media Streams has no message for sending DTMF." },
      stream_auth_validation: hasAuthToken
        ? { support: "supported", note: "Validates the lowercase x-twilio-signature header on the WebSocket handshake." }
        : { support: "requires_configuration", note: "Pass authToken to TwilioMediaTransport." },
      provider_noise_suppression: {
        support: "unsupported",
        note: "No noise-suppression option found in the Media Streams docs reviewed on 2026-10-23.",
      },
      stream_recovery: { support: "unsupported", note: "Twilio does not document resuming a stream after disconnect." },
    },
  };
}

function callControlCapabilities(): ProviderCapabilities {
  return {
    provider: TWILIO,
    adapterVersion: ADAPTER_VERSION,
    capabilities: {
      ...each(MEDIA_ONLY, { support: "unsupported", note: "Media capability; see TwilioMediaTransport." }),
      provider_noise_suppression: { support: "unsupported", note: "Media capability; see TwilioMediaTransport." },
      inbound_calls: { support: "supported", note: "Twilio calls your voice webhook; respond with TwiML. parseWebhook normalizes status callbacks." },
      outbound_calls: { support: "supported" },
      answer_call: { support: "unavailable_from_provider", note: "Calls are answered by returning TwiML from your webhook." },
      end_call: { support: "supported" },
      call_transfer: { support: "supported", note: "Replaces the call's TwiML with <Dial>; an active <Connect><Stream> ends." },
      call_status_events: { support: "supported" },
      media_stream_control: {
        support: "supported",
        note: "REST-created streams are unidirectional; return <Connect><Stream> TwiML for bidirectional audio.",
      },
      recording_access: { support: "unsupported", note: "Not implemented yet." },
      dtmf_send: { support: "unsupported", note: "Twilio has no REST DTMF operation that keeps the current TwiML running." },
      webhook_validation: { support: "supported", note: "X-Twilio-Signature, including bodySHA256 JSON bodies." },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Adapters

export interface TwilioCallControlOptions {
  /** Account SID (not secret). */
  readonly accountSid: string;
  readonly authToken: SecretResolver;
  readonly http?: HttpClient;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

const TWILIO_STATUS: Readonly<Record<string, CallStatus>> = {
  queued: "queued",
  initiated: "queued",
  ringing: "ringing",
  "in-progress": "in_progress",
  answered: "in_progress",
  completed: "completed",
  busy: "busy",
  failed: "failed",
  "no-answer": "no_answer",
  canceled: "canceled",
};

const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const seg = (s: string) => encodeURIComponent(s);

function invalid(message: string): ProviderError {
  return new ProviderError({ code: "invalid_configuration", provider: TWILIO, message });
}

/** Twilio REST call control (Calls and Streams resources) plus webhook validation and parsing. */
export class TwilioCallControl extends BaseCallControlAdapter {
  readonly provider = TWILIO;
  private readonly http: HttpClient;
  private readonly baseUrl: string;
  private readonly now: () => number;

  constructor(private readonly options: TwilioCallControlOptions) {
    super();
    if (!options.accountSid) throw invalid("accountSid is required.");
    this.http = options.http ?? fetchHttpClient;
    this.baseUrl = (options.baseUrl ?? "https://api.twilio.com").replace(/\/$/, "");
    this.now = options.now ?? Date.now;
  }

  capabilities(): ProviderCapabilities {
    return callControlCapabilities();
  }

  override async validateWebhook(req: WebhookRequest): Promise<void> {
    if (!validateTwilioRequest(await this.options.authToken(), req)) {
      throw new ProviderError({ code: "signature_invalid", provider: TWILIO, message: "X-Twilio-Signature did not match." });
    }
  }

  /** Parses a status callback. Call validateWebhook first; this method does not authenticate. */
  override async parseWebhook(req: WebhookRequest): Promise<TelephonyEvent[]> {
    const form = new URLSearchParams(req.rawBody);
    const callSid = form.get("CallSid");
    const status = form.get("CallStatus");
    if (!callSid || !status) {
      throw new ProviderError({ code: "malformed_message", provider: TWILIO, message: "Status callback needs CallSid and CallStatus." });
    }
    const seq = form.get("SequenceNumber");
    return [
      {
        type: "call_status",
        provider: TWILIO,
        callId: callSid,
        sessionId: callSid,
        receivedAtMs: this.now(),
        providerSequence: seq !== null && /^\d+$/.test(seq) ? Number(seq) : null,
        status: TWILIO_STATUS[status] ?? "unknown",
        providerStatus: status,
      },
    ];
  }

  override async startOutboundCall(req: OutboundCallRequest, opts?: OperationOptions): Promise<CallSession> {
    requireCapability(this.capabilities(), "outbound_calls");
    if (!req.to || !req.from) throw invalid("to and from are required.");
    const a = req.answer;
    const url = typeof a["url"] === "string" ? a["url"] : undefined;
    const twiml = typeof a["twiml"] === "string" ? a["twiml"] : undefined;
    if ((url === undefined) === (twiml === undefined)) throw invalid("Pass exactly one of answer.url or answer.twiml.");
    const form = new URLSearchParams({ To: req.to, From: req.from });
    if (url !== undefined) form.append("Url", url);
    else form.append("Twiml", twiml!);
    if (typeof a["statusCallback"] === "string") form.append("StatusCallback", a["statusCallback"]);
    const events = a["statusCallbackEvents"];
    if (events !== undefined) {
      if (!Array.isArray(events) || events.some((e) => typeof e !== "string")) throw invalid("answer.statusCallbackEvents must be strings.");
      for (const e of events as string[]) form.append("StatusCallbackEvent", e);
    }
    const body = jsonBody(TWILIO, await this.post("/Calls.json", form, opts));
    if (typeof body["sid"] !== "string") throw this.unexpected();
    const status = typeof body["status"] === "string" ? body["status"] : "";
    return { callId: body["sid"], provider: TWILIO, direction: "outbound", status: TWILIO_STATUS[status] ?? "unknown", from: req.from, to: req.to };
  }

  override async endCall(callId: string, opts?: OperationOptions): Promise<void> {
    requireCapability(this.capabilities(), "end_call");
    await this.post(`/Calls/${seg(callId)}.json`, new URLSearchParams({ Status: "completed" }), opts);
  }

  override async transferCall(callId: string, target: TransferTarget, opts?: OperationOptions): Promise<void> {
    requireCapability(this.capabilities(), "call_transfer");
    if (!target.to) throw invalid("Transfer target is required.");
    const twiml = `<Response><Dial>${xmlEscape(target.to)}</Dial></Response>`;
    await this.post(`/Calls/${seg(callId)}.json`, new URLSearchParams({ Twiml: twiml }), opts);
  }

  override async startMediaStream(callId: string, req: MediaStreamRequest, opts?: OperationOptions): Promise<MediaStreamHandle> {
    requireCapability(this.capabilities(), "media_stream_control");
    if (req.bidirectional) {
      throw invalid("Twilio's Stream resource creates unidirectional streams. Return <Connect><Stream> TwiML for bidirectional audio.");
    }
    if (!req.url.startsWith("wss://")) throw invalid("Stream url must start with wss://.");
    const f = req.format;
    if (f && (f.encoding !== "mulaw" || f.sampleRate !== 8000 || f.channels !== 1)) {
      throw new ProviderError({ code: "unsupported_format", provider: TWILIO, message: "Twilio streams are audio/x-mulaw 8000 Hz mono." });
    }
    const tracks = new Set(req.tracks);
    const track =
      tracks.has("inbound") && tracks.has("outbound") ? "both_tracks" : tracks.has("outbound") ? "outbound_track" : tracks.has("inbound") ? "inbound_track" : null;
    if (track === null) throw invalid("tracks must include inbound and/or outbound.");
    const o = req.providerOptions ?? {};
    for (const key of Object.keys(o)) {
      if (!["name", "statusCallback", "customParameters"].includes(key)) throw invalid(`Unknown Twilio stream option ${key}.`);
    }
    const form = new URLSearchParams({ Url: req.url, Track: track });
    if (typeof o["name"] === "string") form.append("Name", o["name"]);
    if (typeof o["statusCallback"] === "string") form.append("StatusCallback", o["statusCallback"]);
    const custom = o["customParameters"];
    if (custom !== undefined) {
      const entries = Object.entries(custom as Record<string, unknown>);
      if (entries.length > 99 || entries.some(([, v]) => typeof v !== "string")) throw invalid("customParameters: at most 99 string values.");
      entries.forEach(([k, v], i) => {
        form.append(`Parameter${i + 1}.Name`, k);
        form.append(`Parameter${i + 1}.Value`, v as string);
      });
    }
    const body = jsonBody(TWILIO, await this.post(`/Calls/${seg(callId)}/Streams.json`, form, opts));
    if (typeof body["sid"] !== "string") throw this.unexpected();
    return { callId, streamId: body["sid"] };
  }

  override async stopMediaStream(callId: string, streamId: string, opts?: OperationOptions): Promise<void> {
    requireCapability(this.capabilities(), "media_stream_control");
    await this.post(`/Calls/${seg(callId)}/Streams/${seg(streamId)}.json`, new URLSearchParams({ Status: "stopped" }), opts);
  }

  async health(): Promise<AdapterHealth> {
    return { provider: TWILIO, status: "healthy", checkedAtMs: Date.now(), detail: "Configuration only; no remote probe." };
  }

  private async post(path: string, form: URLSearchParams, opts?: OperationOptions): Promise<HttpResponse> {
    const token = await this.options.authToken();
    const timeoutMs = opts?.timeoutMs ?? this.options.timeoutMs;
    return callApi(
      TWILIO,
      this.http,
      {
        method: "POST",
        url: `${this.baseUrl}/2010-04-01/Accounts/${seg(this.options.accountSid)}${path}`,
        headers: {
          Authorization: basicAuth(this.options.accountSid, token),
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: form.toString(),
      },
      { ...(timeoutMs !== undefined && { timeoutMs }), ...(opts?.signal && { signal: opts.signal }) },
    );
  }

  private unexpected(): ProviderError {
    return new ProviderError({ code: "protocol_violation", provider: TWILIO, message: "Twilio response is missing sid." });
  }
}

export interface TwilioMediaTransportOptions {
  /** Needed to validate the WebSocket handshake signature. */
  readonly authToken?: SecretResolver;
}

export class TwilioMediaTransport implements MediaTransportAdapter {
  readonly provider = TWILIO;

  constructor(private readonly options: TwilioMediaTransportOptions = {}) {}

  capabilities(): ProviderCapabilities {
    return mediaCapabilities(this.options.authToken !== undefined);
  }

  async validateConnection(req: StreamConnectionRequest): Promise<void> {
    requireCapability(this.capabilities(), "stream_auth_validation");
    const token = await this.options.authToken!();
    if (!validateTwilioRequest(token, { method: "GET", url: req.url, headers: req.headers, rawBody: "" })) {
      throw new ProviderError({
        code: "signature_invalid",
        provider: TWILIO,
        message: "x-twilio-signature on the Media Streams handshake did not match.",
      });
    }
  }

  createSession(connection: MediaConnection, options?: MediaSessionOptions): TwilioMediaSession {
    return new TwilioMediaSession(connection, this.capabilities(), options);
  }
}

export class TwilioMediaSession extends BaseMediaSession {
  constructor(connection: MediaConnection, capabilities: ProviderCapabilities, options?: MediaSessionOptions) {
    super(TWILIO, connection, capabilities, BIDIRECTIONAL_DEPENDENT, options);
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
        const seq = r.optionalInt(msg, "sequenceNumber");
        const start = r.object(msg, "start");
        const streamSid = r.id(start, "streamSid", "start.streamSid");
        const callSid = r.id(start, "callSid", "start.callSid");
        const tracks = r.stringArray(start, "tracks", "start.tracks").map((t) => this.track(t, "start.tracks"));
        const mf = r.object(start, "mediaFormat", "start.mediaFormat");
        const encoding = r.string(mf, "encoding", "start.mediaFormat.encoding");
        const format: AudioFormat = {
          encoding: "mulaw",
          sampleRate: r.int(mf, "sampleRate", "start.mediaFormat.sampleRate"),
          channels: r.int(mf, "channels", "start.mediaFormat.channels"),
        };
        if (encoding !== "audio/x-mulaw" || !(SUPPORTED_SAMPLE_RATES as readonly number[]).includes(format.sampleRate)) {
          throw new ProviderError({
            code: "unsupported_format",
            provider: TWILIO,
            message: `Unsupported Twilio media format ${encoding} at ${format.sampleRate} Hz.`,
          });
        }
        const customParameters = this.customParameters(start);
        this.begin(callSid, streamSid, format);
        this.emit({
          type: "stream_started",
          ...this.eventBase(seq),
          tracks,
          format,
          bidirectional: this.bidirectional ?? null,
          ...(customParameters !== undefined && { customParameters }),
        });
        return;
      }
      case "media": {
        this.requireActive(event);
        this.requireSameStream(r.optionalString(msg, "streamSid"));
        const seq = r.optionalInt(msg, "sequenceNumber");
        const media = r.object(msg, "media");
        const direction = this.track(r.string(media, "track", "media.track"), "media.track");
        const timestamp = r.optionalInt(media, "timestamp", "media.timestamp");
        const chunk = r.optionalInt(media, "chunk", "media.chunk");
        const payload = r.base64(media, "payload", "media.payload");
        validateAudioPayload(this.inputFormat!, payload.byteLength, this.maxPayloadBytes, TWILIO);
        this.emit({
          type: "audio",
          ...this.eventBase(seq),
          frame: {
            callId: this.callId!,
            sessionId: this.sessionId!,
            provider: TWILIO,
            direction,
            format: this.inputFormat!,
            payload,
            timestampMs: timestamp,
            timestampKind: timestamp === null ? "none" : "stream_relative_ms",
            sequenceNumber: seq,
            chunk,
            isCompleteFrame: false,
          },
        });
        return;
      }
      case "dtmf": {
        this.requireActive(event);
        this.requireSameStream(r.optionalString(msg, "streamSid"));
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
      case "mark": {
        this.requireActive(event);
        this.requireSameStream(r.optionalString(msg, "streamSid"));
        const seq = r.optionalInt(msg, "sequenceNumber");
        const name = r.string(r.object(msg, "mark"), "name", "mark.name");
        this.emit({ type: "playback_mark", ...this.eventBase(seq), name });
        return;
      }
      case "stop":
        this.requireActive(event);
        this.requireSameStream(r.optionalString(msg, "streamSid"));
        this.finish("provider_stop", r.optionalInt(msg, "sequenceNumber"));
        return;
      default:
        this.ignore();
    }
  }

  async sendAudio(payload: Uint8Array, format: AudioFormat): Promise<void> {
    requireCapability(this.capabilities(), "playback");
    if (format.encoding !== "mulaw" || format.sampleRate !== 8000 || format.channels !== 1) {
      throw new ProviderError({
        code: "unsupported_format",
        provider: TWILIO,
        capability: "playback",
        message: "Twilio plays audio/x-mulaw 8000 Hz mono only. Resample and encode with encodeMulaw first.",
      });
    }
    if (payload.byteLength === 0) throw this.invalid("Cannot play an empty payload.", "playback");
    await this.sendJson("playback", {
      event: "media",
      streamSid: this.sessionId,
      media: { payload: Buffer.from(payload).toString("base64") },
    });
  }

  async sendMark(name: string): Promise<void> {
    requireCapability(this.capabilities(), "playback_marks");
    if (name.length === 0) throw this.invalid("Mark name must not be empty.", "playback_marks");
    await this.sendJson("playback_marks", { event: "mark", streamSid: this.sessionId, mark: { name } });
  }

  async clearPlayback(): Promise<void> {
    await this.sendJson("playback_interruption", { event: "clear", streamSid: this.sessionId });
  }

  async sendDtmf(): Promise<void> {
    requireCapability(this.capabilities(), "dtmf_send");
  }

  private track(value: string, path: string): MediaDirection {
    if (value === "inbound" || value === "outbound") return value;
    throw this.reader.fail(`${path} has unknown track "${value}".`);
  }

  private customParameters(start: JsonObject): Record<string, string> | undefined {
    if (start["customParameters"] === undefined) return undefined;
    const params = this.reader.object(start, "customParameters", "start.customParameters");
    for (const [key, value] of Object.entries(params)) {
      if (typeof value !== "string") throw this.reader.fail(`start.customParameters.${key} must be a string.`);
    }
    return params as Record<string, string>;
  }

  private violation(message: string): ProviderError {
    return new ProviderError({ code: "protocol_violation", provider: TWILIO, message });
  }
}
