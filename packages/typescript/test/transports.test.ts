// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vasik Mansuri
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AudioPipeline,
  GenericJsonMediaTransport,
  RawPcmMediaSession,
  RecordingConnection,
  RtpMediaSession,
  RtpPacketizer,
  fileFrames,
  mediaConformanceChecks,
  parseRtpPacket,
  readWav,
  writeWavPcm16,
  type TelephonyEvent,
} from "../src/index.js";

const contracts = fileURLToPath(new URL("../../../contracts/", import.meta.url));
const fixture = JSON.parse(readFileSync(contracts + "fixtures/transports/rtp-wav.json", "utf8"));
const hex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("RTP parsing vectors", () => {
  for (const c of fixture.rtp) {
    it(c.name, () => {
      if (c.expectError) return expect(() => parseRtpPacket(hex(c.hex))).toThrow(expect.objectContaining({ code: c.expectError }));
      const { payload, ...rest } = parseRtpPacket(hex(c.hex));
      expect({ ...rest, payloadHex: toHex(payload) }).toEqual(c.expect);
    });
  }
});

describe("WAV reading vectors", () => {
  for (const c of fixture.wav) {
    it(c.name, () => {
      if (c.expectError) return expect(() => readWav(hex(c.hex))).toThrow(expect.objectContaining({ code: c.expectError }));
      const wav = readWav(hex(c.hex));
      expect({ format: wav.format, dataHex: toHex(wav.data) }).toEqual(c.expect);
    });
  }

  it("round-trips writeWavPcm16 and frames a recording", () => {
    const pcm = new Uint8Array(16000 * 2 * 0.05).map((_, i) => i % 251);
    const wav = readWav(writeWavPcm16(pcm, 16000));
    expect(wav.format).toEqual({ encoding: "pcm_s16le", sampleRate: 16000, channels: 1 });
    const frames = fileFrames(wav, { callId: "rec-1", sessionId: "rec-1" });
    expect(frames.map((f) => [f.payload.byteLength, f.isCompleteFrame, f.timestampMs])).toEqual([
      [640, true, 0],
      [640, true, 20],
      [320, false, 40],
    ]);
    expect(Buffer.concat(frames.map((f) => f.payload))).toEqual(Buffer.from(pcm));
  });
});

async function drain(session: { events(): AsyncIterable<TelephonyEvent>; close(): Promise<void> }) {
  await session.close();
  const out: TelephonyEvent[] = [];
  for await (const e of session.events()) out.push(e);
  return out;
}

describe("RtpMediaSession", () => {
  const packetizer = () => new RtpPacketizer({ payloadType: 0, ssrc: 42, initialSequence: 65534, initialTimestamp: 4294967136 });

  it("handles wraparound, gaps, duplicates and timestamps", async () => {
    const p = packetizer();
    const packets = [0, 1, 2, 3].map(() => p.packetize(new Uint8Array(160).fill(0xff), 160));
    const session = new RtpMediaSession(new RecordingConnection(), { callId: "c", sessionId: "s", now: () => 0 });
    session.receive(packets[0]!);
    session.receive(packets[0]!);
    session.receive(packets[2]!);
    session.receive(packets[1]!);
    session.receive(packets[3]!);
    expect(session.stats).toEqual({ packets: 3, lostPackets: 1, latePackets: 2, ssrcChanges: 0 });
    const audio = (await drain(session)).filter((e) => e.type === "audio");
    expect(audio.map((e) => (e.type === "audio" ? [e.frame.sequenceNumber, e.frame.timestampMs] : null))).toEqual([
      [65534, 0],
      [0, 40],
      [1, 60],
    ]);
  });

  it("converts big-endian L16 and refuses unknown payload types", () => {
    const session = new RtpMediaSession(new RecordingConnection(), {
      callId: "c",
      sessionId: "s",
      payloadTypes: { 118: { format: { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 }, byteOrder: "big" } },
    });
    expect(() => session.receive(packetizer().packetize(new Uint8Array(2), 1))).toThrow(/payload type 0 is not configured/);
    const l16 = new RtpPacketizer({ payloadType: 118, ssrc: 1 }).packetize(hex("0001"), 1);
    session.receive(l16);
    expect(session.inputFormat).toEqual({ encoding: "pcm_s16le", sampleRate: 16000, channels: 1 });
  });

  it("plays back as RTP only when configured", async () => {
    const sent: Uint8Array[] = [];
    const conn = Object.assign(new RecordingConnection(), { sendBinary: async (d: Uint8Array) => void sent.push(d) });
    const mulaw = { encoding: "mulaw", sampleRate: 8000, channels: 1 } as const;
    const quiet = new RtpMediaSession(conn, { callId: "c", sessionId: "s" });
    await expect(quiet.sendAudio(new Uint8Array(160), mulaw)).rejects.toMatchObject({ code: "invalid_configuration" });
    const live = new RtpMediaSession(conn, { callId: "c", sessionId: "s", playback: { payloadType: 0, ssrc: 7 } });
    await live.sendAudio(new Uint8Array(160).fill(0xff), mulaw);
    await live.sendAudio(new Uint8Array(160).fill(0xff), mulaw);
    const [a, b] = sent.map((d) => parseRtpPacket(d));
    expect([a!.ssrc, a!.sequenceNumber, b!.sequenceNumber, b!.timestamp - a!.timestamp]).toEqual([7, 0, 1, 160]);
  });
});

describe("RawPcmMediaSession", () => {
  const l16 = { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 } as const;

  it("turns binary frames into audio and passes text through", async () => {
    const texts: string[] = [];
    const session = new RawPcmMediaSession(new RecordingConnection(), { callId: "c", sessionId: "s", format: l16, onText: (t) => texts.push(t), now: () => 0 });
    session.receive('{"event":"websocket:connected"}');
    session.receive(new Uint8Array(640));
    session.receive(new Uint8Array(640));
    expect(() => session.receive(new Uint8Array(3))).toThrow(expect.objectContaining({ code: "malformed_message" }));
    const events = await drain(session);
    expect(texts).toEqual(['{"event":"websocket:connected"}']);
    expect(events.map((e) => e.type)).toEqual(["stream_started", "audio", "audio", "stream_stopped"]);
    expect(events.filter((e) => e.type === "audio").map((e) => (e.type === "audio" ? e.frame.timestampMs : 0))).toEqual([0, 20]);
  });

  it("refuses playback without a binary-capable bidirectional connection", async () => {
    const textOnly = { sendText: async () => {}, close: async () => {} };
    const session = new RawPcmMediaSession(textOnly, { callId: "c", sessionId: "s", format: l16, bidirectional: true });
    await expect(session.sendAudio(new Uint8Array(640), l16)).rejects.toMatchObject({ code: "invalid_configuration" });
  });
});

const generic = () =>
  new GenericJsonMediaTransport({
    provider: "acme",
    eventField: "type",
    events: { start: "call.start", media: "call.audio", stop: "call.end" },
    paths: { callId: "call.id", sessionId: "stream.id", payload: "audio.data", track: "audio.side", sequence: "seq" },
    trackValues: { caller: "inbound", agent: "outbound" },
    format: { encoding: "mulaw", sampleRate: 8000, channels: 1 },
  });

describe("GenericJsonMediaTransport", () => {
  for (const c of mediaConformanceChecks({
    name: "generic-json",
    createAdapter: generic,
    inputFormat: { encoding: "mulaw", sampleRate: 8000, channels: 1 },
    startMessage: ({ callId, sessionId }) => JSON.stringify({ type: "call.start", call: { id: callId }, stream: { id: sessionId } }),
    mediaMessage: (_ids, payload, seq) => JSON.stringify({ type: "call.audio", seq, audio: { data: payload, side: "caller" } }),
    stopMessage: () => JSON.stringify({ type: "call.end" }),
  })) {
    it(`conformance: ${c.name}`, c.run);
  }

  it("maps configured track names and rejects unknown ones", async () => {
    const session = generic().createSession(new RecordingConnection());
    session.receive(JSON.stringify({ type: "call.start", call: { id: "c" }, stream: { id: "s" } }));
    session.receive(JSON.stringify({ type: "call.audio", seq: 1, audio: { data: "fw==", side: "agent" } }));
    expect(() => session.receive(JSON.stringify({ type: "call.audio", seq: 2, audio: { data: "fw==", side: "bot" } }))).toThrow(/unknown track/);
    const events = await drain(session);
    expect(events[1]?.type === "audio" && events[1].frame.direction).toBe("outbound");
  });
});

describe("recordings reach the same pipeline as live audio", () => {
  it("processes a WAV recording into 16 kHz frames", () => {
    const wav = readWav(writeWavPcm16(new Uint8Array(8000 * 2 * 0.04), 8000));
    const pipeline = new AudioPipeline({ targetSampleRate: 16000 });
    const out = [...fileFrames(wav, { callId: "rec", sessionId: "rec" }).flatMap((f) => pipeline.push(f)), ...pipeline.flush()];
    expect(out.map((f) => f.payload.byteLength)).toEqual([640, 640]);
  });
});
