// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vasik Mansuri
/**
 * Vonage Voice API WebSockets.
 * Protocol: https://developer.vonage.com/en/voice/voice-api/concepts/websockets
 * A websocket:connected text message announces audio/l16;rate=N, then audio flows as binary 16-bit
 * little-endian PCM in both directions. Vonage sends no call id on the socket; the host supplies it.
 * Call control (Vonage Voice REST API) is not implemented: register Vonage with callControl: null.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { MediaConnection, MediaSessionOptions, MediaTransportAdapter, SecretResolver, StreamConnectionRequest } from "../adapters.js";
import { bytesPerSample, validateAudioPayload } from "../audio.js";
import { requireCapability } from "../capabilities.js";
import { ProviderError } from "../errors.js";
import { DTMF_DIGIT, getHeader, isObject, MessageReader } from "../parse.js";
import { BinaryMediaSession } from "../transports.js";
import { CAPABILITIES, type AudioFormat, type Capability, type CapabilityEntry, type ProviderCapabilities } from "../types.js";

export const VONAGE = "vonage";
const ADAPTER_VERSION = "0.1.0";
const RATES = [8000, 16000, 24000];

export type VonageAuthorization =
  | { readonly mode: "custom"; readonly expected: SecretResolver }
  | { readonly mode: "vonage"; readonly signatureSecret: SecretResolver; readonly maxAgeSeconds?: number; readonly now?: () => number };

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Verifies an HS256 JWT signed with the Vonage signature secret (the signed-webhooks format Vonage uses
 * for the handshake's `Authorization: Bearer` header). Requires iat within maxAgeSeconds; honours exp and nbf.
 */
export function verifyVonageJwt(token: string, secret: string, options: { readonly nowMs?: number; readonly maxAgeSeconds?: number } = {}): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [h, p, s] = parts as [string, string, string];
  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (!isObject(header) || header["alg"] !== "HS256" || !isObject(payload)) return false;
  const expected = createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  if (!safeEqual(expected, s)) return false;
  const now = (options.nowMs ?? Date.now()) / 1000;
  const { iat, exp, nbf } = payload;
  if (typeof iat !== "number" || now - iat > (options.maxAgeSeconds ?? 300) || iat - now > 60) return false;
  if (typeof exp === "number" && exp < now) return false;
  if (typeof nbf === "number" && nbf > now + 60) return false;
  return true;
}

export interface VonageSessionOptions extends MediaSessionOptions {
  readonly callId: string;
  readonly sessionId: string;
}

export class VonageMediaTransport implements MediaTransportAdapter {
  readonly provider = VONAGE;

  constructor(private readonly options: { readonly authorization?: VonageAuthorization } = {}) {}

  capabilities(): ProviderCapabilities {
    return vonageCapabilities(this.options.authorization !== undefined, true);
  }

  async validateConnection(req: StreamConnectionRequest): Promise<void> {
    requireCapability(this.capabilities(), "stream_auth_validation");
    const auth = this.options.authorization!;
    const header = getHeader(req.headers, "authorization") ?? "";
    let ok: boolean;
    if (auth.mode === "custom") {
      ok = safeEqual(header, await auth.expected());
    } else {
      ok =
        header.startsWith("Bearer ") &&
        verifyVonageJwt(header.slice(7), await auth.signatureSecret(), {
          nowMs: (auth.now ?? Date.now)(),
          ...(auth.maxAgeSeconds !== undefined && { maxAgeSeconds: auth.maxAgeSeconds }),
        });
    }
    if (!ok) throw new ProviderError({ code: "authentication_failed", provider: VONAGE, message: "Vonage WebSocket authorization failed." });
  }

  createSession(connection: MediaConnection, options: VonageSessionOptions): VonageMediaSession {
    return new VonageMediaSession(connection, options);
  }
}

function vonageCapabilities(hasAuth: boolean, canSendBinary: boolean): ProviderCapabilities {
  const base = Object.fromEntries(
    CAPABILITIES.map((c) => [c, { support: "unsupported", note: "Call-control capability; the Vonage Voice REST API is not implemented." }]),
  ) as Record<Capability, CapabilityEntry>;
  const playback: CapabilityEntry = canSendBinary
    ? { support: "supported" }
    : { support: "requires_configuration", note: "The connection must implement sendBinary." };
  return {
    provider: VONAGE,
    adapterVersion: ADAPTER_VERSION,
    capabilities: {
      ...base,
      live_inbound_audio: { support: "supported" },
      bidirectional_audio: playback,
      playback,
      playback_marks: playback,
      playback_interruption: playback,
      dtmf_receive: { support: "supported" },
      dtmf_send: { support: "unsupported", note: "Vonage sends DTMF through the REST API (not implemented)." },
      separate_tracks: { support: "unavailable_from_provider", note: "The socket carries one audio stream." },
      stream_auth_validation: hasAuth
        ? { support: "supported", note: "Custom header value or Vonage-signed HS256 JWT." }
        : { support: "requires_configuration", note: "Configure websocket authorization in the NCCO and pass it here." },
    },
  };
}

export class VonageMediaSession extends BinaryMediaSession {
  private readonly reader = new MessageReader(VONAGE);
  private samples = 0;
  private chunks = 0;
  private ignoredText = 0;

  constructor(connection: MediaConnection, options: VonageSessionOptions) {
    super(VONAGE, connection, options);
  }

  get ignoredMessages(): number {
    return this.ignoredText;
  }

  capabilities(): ProviderCapabilities {
    return vonageCapabilities(false, typeof this.connection.sendBinary === "function");
  }

  receive(message: string | Uint8Array): void {
    this.requireOpen();
    if (typeof message !== "string") return this.audio(message);
    const msg = this.reader.json(message);
    switch (msg["event"]) {
      case "websocket:connected": {
        if (this.inputFormat !== null) throw this.violation("websocket:connected arrived twice.");
        const contentType = this.reader.string(msg, "content-type");
        const match = /^audio\/l16\s*;\s*rate=(\d+)$/i.exec(contentType.trim());
        const rate = match ? Number(match[1]) : NaN;
        if (!RATES.includes(rate)) {
          throw new ProviderError({ code: "unsupported_format", provider: VONAGE, message: `Unsupported Vonage content-type ${contentType}.` });
        }
        const custom = Object.fromEntries(
          Object.entries(msg).filter((e): e is [string, string] => e[0] !== "event" && e[0] !== "content-type" && typeof e[1] === "string"),
        );
        this.start(
          { encoding: "pcm_s16le", sampleRate: rate, channels: 1 },
          { bidirectional: true, ...(Object.keys(custom).length > 0 && { customParameters: custom }) },
        );
        return;
      }
      case "websocket:dtmf": {
        this.requireStarted("websocket:dtmf");
        const digit = this.reader.string(msg, "digit");
        if (!DTMF_DIGIT.test(digit)) throw this.reader.fail("digit must be a single DTMF character.");
        this.emitEvent({ type: "dtmf", ...this.base(null), digit, direction: "inbound" });
        return;
      }
      case "websocket:notify": {
        this.requireStarted("websocket:notify");
        const payload = msg["payload"];
        if (isObject(payload) && typeof payload["name"] === "string") {
          this.emitEvent({ type: "playback_mark", ...this.base(null), name: payload["name"] });
        } else {
          this.ignoredText++;
        }
        return;
      }
      case "websocket:cleared":
        this.requireStarted("websocket:cleared");
        this.emitEvent({ type: "playback_cleared", ...this.base(null) });
        return;
      default:
        this.ignoredText++;
    }
  }

  async sendAudio(payload: Uint8Array, format: AudioFormat): Promise<void> {
    requireCapability(this.capabilities(), "playback");
    this.requireOpen();
    const input = this.inputFormat;
    if (!input) throw this.violation("Cannot play audio before websocket:connected.");
    if (format.encoding !== input.encoding || format.sampleRate !== input.sampleRate || format.channels !== input.channels) {
      throw new ProviderError({ code: "unsupported_format", provider: VONAGE, capability: "playback", message: "Playback must match the socket's content-type." });
    }
    if (payload.byteLength === 0) throw new ProviderError({ code: "invalid_configuration", provider: VONAGE, message: "Cannot play an empty payload." });
    await this.connection.sendBinary!(payload);
  }

  override async sendMark(name: string): Promise<void> {
    requireCapability(this.capabilities(), "playback_marks");
    this.requireOpen();
    await this.connection.sendText(JSON.stringify({ action: "notify", payload: { name } }));
  }

  override async clearPlayback(): Promise<void> {
    requireCapability(this.capabilities(), "playback_interruption");
    this.requireOpen();
    await this.connection.sendText(JSON.stringify({ action: "clear" }));
  }

  private audio(message: Uint8Array): void {
    const format = this.inputFormat;
    if (format === null) throw this.violation("Binary audio arrived before websocket:connected.");
    validateAudioPayload(format, message.byteLength, this.maxPayloadBytes, VONAGE);
    const payload = new Uint8Array(message);
    const timestampMs = (this.samples * 1000) / format.sampleRate;
    this.samples += payload.byteLength / bytesPerSample(format);
    this.emitAudio(
      {
        callId: this.callId,
        sessionId: this.sessionId,
        provider: VONAGE,
        direction: "inbound",
        format,
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

  private requireStarted(event: string): void {
    if (this.inputFormat === null) throw this.violation(`${event} arrived before websocket:connected.`);
  }

  private violation(message: string): ProviderError {
    return new ProviderError({ code: "protocol_violation", provider: VONAGE, message });
  }
}
