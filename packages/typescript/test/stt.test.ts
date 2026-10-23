import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AudioPipeline,
  EmailCapture,
  ProviderError,
  SttAudioBridge,
  TranscriptReconciler,
  type AudioFrame,
} from "../src/index.js";
import { DeepgramStreamingSession, deepgramListenUrl, parseDeepgramMessage, type SttConnection } from "../src/providers/deepgram.js";

const contracts = fileURLToPath(new URL("../../../contracts/", import.meta.url));
const load = (path: string): any => JSON.parse(readFileSync(contracts + path, "utf8"));

describe("TranscriptReconciler", () => {
  for (const c of load("fixtures/stt/reconciler.json").cases) {
    it(c.name, () => {
      const reconciler = new TranscriptReconciler({ tenantId: "t1", sessionId: "s1", now: () => 1000 });
      expect(c.inputs.flatMap((input: any) => reconciler.accept(input))).toEqual(c.expect);
    });
  }
});

describe("Deepgram message parsing", () => {
  for (const [i, c] of load("fixtures/providers/deepgram/messages.json").cases.entries()) {
    it(`case ${i}`, () => {
      const run = () => parseDeepgramMessage(c.raw ?? JSON.stringify(c.message));
      if (c.expectError) expect(run).toThrow(expect.objectContaining({ code: c.expectError }));
      else expect(run()).toEqual(c.expect);
    });
  }

  it("builds a listen URL and enforces the interim_results rule", () => {
    expect(deepgramListenUrl({ format: { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 }, utteranceEndMs: 1000, model: "nova-3" })).toBe(
      "wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&channels=1&interim_results=true&model=nova-3&utterance_end_ms=1000",
    );
    expect(() => deepgramListenUrl({ format: { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 }, utteranceEndMs: 1000, interimResults: false })).toThrow(
      /interim_results/,
    );
  });
});

class FakeSocket implements SttConnection {
  binary: Uint8Array[] = [];
  text: string[] = [];
  async sendBinary(data: Uint8Array) {
    this.binary.push(data);
  }
  async sendText(data: string) {
    this.text.push(data);
  }
  async close() {}
}

const pcm16k = { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 } as const;

describe("audio -> STT -> transcript -> email", () => {
  it("sends exactly the pipeline's processed frames to STT", async () => {
    const socket = new FakeSocket();
    const session = new DeepgramStreamingSession(socket, pcm16k);
    const pipeline = new AudioPipeline({
      targetSampleRate: 16000,
      processors: [{ name: "invert", kind: "noise_suppression", sampleRate: 16000, frameSamples: 320, process: (p) => p.map((b) => 255 - b) }],
    });
    const bridge = new SttAudioBridge(pipeline, session, pcm16k);
    const frame: AudioFrame = {
      callId: "c", sessionId: "s", provider: "twilio", direction: "inbound", format: { encoding: "mulaw", sampleRate: 8000, channels: 1 },
      payload: new Uint8Array(160).fill(0xff), timestampMs: 0, timestampKind: "stream_relative_ms", sequenceNumber: 1, chunk: 1, isCompleteFrame: false,
    };
    await bridge.push(frame);
    await bridge.push(frame);
    await bridge.end();
    expect(socket.binary).toHaveLength(2);
    expect(socket.binary.every((b) => b.byteLength === 640 && b.every((x) => x === 255))).toBe(true);
    expect(socket.text).toEqual(['{"type":"CloseStream"}']);
  });

  it("refuses a pipeline/STT format mismatch", () => {
    const session = new DeepgramStreamingSession(new FakeSocket(), pcm16k);
    expect(() => new SttAudioBridge(new AudioPipeline({ targetSampleRate: 8000 }), session, pcm16k)).toThrow(ProviderError);
  });

  it("rejects frames in the wrong format", async () => {
    const session = new DeepgramStreamingSession(new FakeSocket(), pcm16k);
    await expect(
      session.sendAudio({ callId: "c", sessionId: "s", provider: "p", direction: "inbound", format: { encoding: "mulaw", sampleRate: 8000, channels: 1 }, payload: new Uint8Array(1), timestampMs: null, timestampKind: "none", sequenceNumber: null, chunk: null, isCompleteFrame: true }),
    ).rejects.toMatchObject({ code: "unsupported_format" });
  });

  it("captures an email spoken across Deepgram segments", async () => {
    const session = new DeepgramStreamingSession(new FakeSocket(), pcm16k);
    for (const c of load("fixtures/providers/deepgram/messages.json").cases) if (c.message && !c.expectError) session.receive(JSON.stringify(c.message));
    await session.close();
    const reconciler = new TranscriptReconciler({ tenantId: "t1", sessionId: "call-1", now: () => 0 });
    const capture = new EmailCapture();
    const results = [];
    for await (const r of session.results()) for (const e of reconciler.accept(r)) results.push(...(await capture.handle(e)));
    expect(results).toEqual([{ type: "candidate", email: "john.smith@gmail.com", literal: false, turnId: "turn-1", replacesConfirmed: false }]);
  });
});
