// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vasik Mansuri
/**
 * Deepgram live transcription (wss://api.deepgram.com/v1/listen).
 * Messages: https://developers.deepgram.com/docs/live-streaming-audio,
 *           https://developers.deepgram.com/docs/understanding-end-of-speech-detection
 * The host opens the WebSocket (with `Authorization: Token <key>`) and passes it in as an SttConnection,
 * so API keys never pass through this module.
 */
import { ProviderError } from "../errors.js";
import { isObject, MessageReader, type JsonObject } from "../parse.js";
import { BoundedQueue } from "../queue.js";
import type { SttCapabilities, SttResult, StreamingSttSession } from "../stt.js";
import type { AudioFormat, AudioFrame } from "../types.js";

export const DEEPGRAM = "deepgram";

export interface SttConnection {
  sendBinary(data: Uint8Array): Promise<void>;
  sendText(data: string): Promise<void>;
  close(): Promise<void>;
}

export interface DeepgramListenOptions {
  readonly format: AudioFormat;
  readonly model?: string;
  readonly language?: string;
  readonly interimResults?: boolean;
  readonly utteranceEndMs?: number;
  readonly endpointingMs?: number;
  readonly smartFormat?: boolean;
}

function encodingParam(format: AudioFormat): string {
  if (format.encoding === "pcm_s16le") return "linear16";
  if (format.encoding === "mulaw") return "mulaw";
  throw new ProviderError({ code: "unsupported_format", provider: DEEPGRAM, message: `No Deepgram encoding mapped for ${format.encoding}.` });
}

/** Builds the listen URL for raw (headerless) audio. Requires interim results when utteranceEndMs is set, as Deepgram does. */
export function deepgramListenUrl(options: DeepgramListenOptions): string {
  const interim = options.interimResults ?? true;
  if (options.utteranceEndMs !== undefined && !interim) {
    throw new ProviderError({
      code: "invalid_configuration",
      provider: DEEPGRAM,
      message: "Deepgram requires interim_results=true when utterance_end_ms is used.",
    });
  }
  const params = new URLSearchParams({
    encoding: encodingParam(options.format),
    sample_rate: String(options.format.sampleRate),
    channels: String(options.format.channels),
    interim_results: String(interim),
  });
  if (options.model) params.set("model", options.model);
  if (options.language) params.set("language", options.language);
  if (options.utteranceEndMs !== undefined) params.set("utterance_end_ms", String(options.utteranceEndMs));
  if (options.endpointingMs !== undefined) params.set("endpointing", String(options.endpointingMs));
  if (options.smartFormat) params.set("smart_format", "true");
  return `wss://api.deepgram.com/v1/listen?${params}`;
}

export function deepgramCapabilities(): SttCapabilities {
  return {
    provider: DEEPGRAM,
    interimResults: true,
    wordTimestamps: true,
    confidence: true,
    diarization: false,
    inputFormats: [8000, 16000, 24000, 48000].flatMap((sampleRate) => [
      { encoding: "pcm_s16le" as const, sampleRate, channels: 1 },
      { encoding: "mulaw" as const, sampleRate, channels: 1 },
    ]),
  };
}

const ms = (seconds: number) => Math.floor(seconds * 1000 + 0.5);

/** Pure translation of one Deepgram server message. Unknown message types yield []. */
export function parseDeepgramMessage(message: string | JsonObject): SttResult[] {
  const r = new MessageReader(DEEPGRAM);
  let msg: JsonObject;
  if (typeof message === "string") {
    try {
      const parsed: unknown = JSON.parse(message);
      if (!isObject(parsed)) throw new Error();
      msg = parsed;
    } catch {
      throw r.fail("Deepgram message is not a JSON object.");
    }
  } else {
    msg = message;
  }
  if (msg["type"] === "UtteranceEnd") return [{ type: "turn_end" }];
  if (msg["type"] !== "Results") return [];
  const alternatives = r.object(msg, "channel")["alternatives"];
  if (!Array.isArray(alternatives) || !isObject(alternatives[0])) throw r.fail("channel.alternatives must be a non-empty array.");
  const best = alternatives[0];
  const text = r.string(best, "transcript", "channel.alternatives[0].transcript");
  const confidence = typeof best["confidence"] === "number" ? best["confidence"] : null;
  if (msg["is_final"] !== true) return [{ type: "interim", text, confidence }];
  const start = msg["start"];
  const duration = msg["duration"];
  if (typeof start !== "number" || typeof duration !== "number") throw r.fail("Final results need numeric start and duration.");
  const out: SttResult[] = [{ type: "segment_final", text, confidence, segmentKey: `${ms(start)}:${ms(duration)}`, startMs: ms(start) }];
  if (msg["speech_final"] === true) out.push({ type: "turn_end" });
  return out;
}

export class DeepgramStreamingSession implements StreamingSttSession {
  private readonly queue: BoundedQueue<SttResult>;

  constructor(
    private readonly connection: SttConnection,
    readonly format: AudioFormat,
    options: { readonly maxQueuedResults?: number } = {},
  ) {
    encodingParam(format);
    this.queue = new BoundedQueue({ capacity: options.maxQueuedResults ?? 1000, overflow: "reject", provider: DEEPGRAM });
  }

  /** Feed each text message from the Deepgram socket here. */
  receive(message: string): void {
    for (const result of parseDeepgramMessage(message)) this.queue.push(result);
  }

  async sendAudio(frame: AudioFrame): Promise<void> {
    const f = frame.format;
    if (f.encoding !== this.format.encoding || f.sampleRate !== this.format.sampleRate || f.channels !== this.format.channels) {
      throw new ProviderError({
        code: "unsupported_format",
        provider: DEEPGRAM,
        message: `Session expects ${this.format.encoding}/${this.format.sampleRate}, got ${f.encoding}/${f.sampleRate}.`,
      });
    }
    await this.connection.sendBinary(frame.payload);
  }

  /** Deepgram KeepAlive, for silences longer than its idle timeout. */
  async keepAlive(): Promise<void> {
    await this.connection.sendText(JSON.stringify({ type: "KeepAlive" }));
  }

  async finish(): Promise<void> {
    await this.connection.sendText(JSON.stringify({ type: "CloseStream" }));
  }

  results(): AsyncIterable<SttResult> {
    return this.queue;
  }

  async close(): Promise<void> {
    this.queue.close();
    await this.connection.close();
  }
}
