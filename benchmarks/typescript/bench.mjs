// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vasik Mansuri
// Micro-benchmarks for the realtime path. Run after `npm run build` in packages/typescript:
//   node benchmarks/typescript/bench.mjs
// Prints measured numbers only; results depend on the machine and are not a performance guarantee.
import os from "node:os";
import {
  AudioPipeline,
  decodeMulaw,
  extractEmail,
  LinearResampler,
  pcm16ToSamples,
  RecordingConnection,
} from "../../packages/typescript/dist/index.js";
import { TwilioMediaTransport } from "../../packages/typescript/dist/providers/twilio.js";

function bench(name, unit, iterations, fn) {
  for (let i = 0; i < Math.min(1000, iterations); i++) fn(i); // warm-up
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn(i);
  const ns = Number(process.hrtime.bigint() - start);
  return { name, unit, iterations, perOpMicros: ns / iterations / 1000, opsPerSecond: Math.round((iterations * 1e9) / ns) };
}

const frame20ms = new Uint8Array(160).fill(0x7f);
const mulawFrame = (i) => ({
  callId: "c", sessionId: "s", provider: "bench", direction: "inbound",
  format: { encoding: "mulaw", sampleRate: 8000, channels: 1 }, payload: frame20ms,
  timestampMs: i * 20, timestampKind: "stream_relative_ms", sequenceNumber: i, chunk: i, isCompleteFrame: false,
});

const results = [];
results.push(bench("G.711 mu-law decode", "20 ms frame (160 B)", 200_000, () => decodeMulaw(frame20ms)));
const resampler = new LinearResampler(8000, 16000);
const samples = pcm16ToSamples(decodeMulaw(frame20ms));
results.push(bench("Resample 8 kHz -> 16 kHz", "20 ms frame", 200_000, () => resampler.push(samples)));
const pipeline = new AudioPipeline({ targetSampleRate: 16000 });
results.push(bench("AudioPipeline (decode+resample+frame)", "20 ms frame", 100_000, (i) => pipeline.push(mulawFrame(i))));

const session = new TwilioMediaTransport().createSession(new RecordingConnection(), { maxQueuedEvents: 1 });
session.receive(JSON.stringify({ event: "start", sequenceNumber: "1", streamSid: "MZ1", start: { streamSid: "MZ1", callSid: "CA1", accountSid: "AC1", tracks: ["inbound"], mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 } } }));
const media = (i) => JSON.stringify({ event: "media", sequenceNumber: String(i + 2), streamSid: "MZ1", media: { track: "inbound", chunk: String(i + 1), timestamp: String(i * 20), payload: Buffer.from(frame20ms).toString("base64") } });
const messages = Array.from({ length: 1000 }, (_, i) => media(i));
results.push(bench("Twilio media message -> AudioFrame", "message", 100_000, (i) => session.receive(messages[i % 1000])));

const utterances = ["my email is john dot smith at gmail dot com", "what are your support hours on public holidays", "you can reach me at jane@example.org"];
results.push(bench("extractEmail", "utterance", 100_000, (i) => extractEmail(utterances[i % 3])));

console.log(JSON.stringify({ runtime: `node ${process.version}`, platform: `${os.platform()} ${os.arch()}`, cpu: os.cpus()[0]?.model, results }, null, 2));
