// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vasik Mansuri
// Live call dashboard: drives a simulated Twilio call through the real toolkit code and streams
// every normalized event to the browser over Server-Sent Events.
//
//   cd packages/typescript && npm run build && cd ../..
//   node examples/live-dashboard/server.mjs     # then open http://localhost:4173
//
// Real code path: Twilio Media Streams JSON -> TwilioMediaSession -> AudioPipeline (mu-law 8 kHz ->
// PCM 16 kHz, 20 ms frames) -> TranscriptReconciler -> EmailCapture + RetrievalCoordinator.
// Only the caller's speech-to-text output is scripted (no STT API key needed); the UI says so.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  AudioPipeline,
  EmailCapture,
  InMemoryRetriever,
  RecordingConnection,
  RetrievalCoordinator,
  SafeRetriever,
  TranscriptReconciler,
  encodeMulaw,
  formatContext,
  pcm16ToSamples,
  samplesToPcm16,
} from "../../packages/typescript/dist/index.js";
import { TwilioMediaTransport } from "../../packages/typescript/dist/providers/twilio.js";

const PORT = Number(process.env.PORT ?? 4173);
const page = fileURLToPath(new URL("./index.html", import.meta.url));
const clients = new Set();

function broadcast(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(line);
}

// ---- Knowledge base for RAG ----------------------------------------------------------------
const kb = new InMemoryRetriever();
kb.upsert([
  {
    id: "faq-hours",
    documentId: "support-faq",
    tenantId: "acme",
    // InMemoryRetriever is a plain keyword matcher (no stop-words), so the demo text avoids filler words.
    text: "Support hours: 9am-5pm, Monday-Friday. Weekends: online help center.",
    metadata: {},
    acl: null,
    source: { title: "Support FAQ", uri: "kb://support-faq#hours", page: null },
  },
  {
    id: "billing-refunds",
    documentId: "billing",
    tenantId: "acme",
    text: "Refunds are processed within 5 business days.",
    metadata: {},
    acl: { principals: [], groups: ["billing"] },
    source: { title: "Billing policy", uri: "kb://billing#refunds", page: null },
  },
]);

// ---- Call script (caller speech timing + scripted STT results) ------------------------------
const SCRIPT = [
  { at: 400, agent: "Hi, thanks for calling Acme! Could I get your email address for the ticket?", asks: true },
  { at: 1500, speak: 2600, interim: ["I'd rather", "I'd rather not"], final: "I'd rather not say right now" },
  { at: 4800, agent: "No problem at all. How can I help you today?" },
  { at: 6000, speak: 3000, interim: ["what are your", "what are your support hours"], final: "what are your support hours on weekends" },
  { at: 9400, agent: "We're open 9am to 5pm, Monday to Friday; on weekends our help center is open. [1]" },
  {
    at: 10800,
    speak: 4200,
    interim: ["oh and my email", "oh and my email is john dot"],
    segments: ["oh and my email is john dot", "smith at gmail dot com"],
  },
  { at: 15400, agent: "Just to confirm, that's john.smith@gmail.com?" },
  { at: 16500, speak: 1200, final: "yes that's right", confirms: true },
  { at: 18200, agent: "Perfect, you're all set. Have a great day!" },
  { at: 19600, end: true },
];

let callNumber = 0;

async function runCall() {
  callNumber++;
  const callSid = `CA${String(callNumber).padStart(30, "0")}demo`;
  const streamSid = `MZ${String(callNumber).padStart(30, "0")}demo`;
  const t0 = Date.now();
  const at = () => Date.now() - t0;

  const session = new TwilioMediaTransport().createSession(new RecordingConnection(), { bidirectional: true });
  const pipeline = new AudioPipeline({ targetSampleRate: 16000 });
  const reconciler = new TranscriptReconciler({ tenantId: "acme", sessionId: callSid });
  const email = new EmailCapture();
  const rag = new RetrievalCoordinator(new SafeRetriever(kb, { timeoutMs: 500 }), {
    tenantId: "acme",
    principal: { id: "caller", groups: [] },
    policy: { minChars: 10 },
  });

  broadcast({ type: "call", phase: "start", callSid, streamSid, number: callNumber });

  // Normalized telephony events -> pipeline -> level meter.
  let frames = 0;
  let processingMicros = 0;
  const consume = (async () => {
    for await (const event of session.events()) {
      if (event.type === "audio") {
        const start = process.hrtime.bigint();
        const out = pipeline.push(event.frame);
        processingMicros += Number(process.hrtime.bigint() - start) / 1000;
        for (const f of out) {
          frames++;
          const s = pcm16ToSamples(f.payload);
          let sum = 0;
          for (const v of s) sum += v * v;
          broadcast({ type: "level", t: at(), rms: Math.sqrt(sum / s.length) / 32768 });
        }
        if (frames % 25 === 0 && frames > 0) {
          broadcast({
            type: "metrics",
            frames,
            avgMicros: processingMicros / Math.max(1, frames),
            dropped: session.droppedAudioFrames,
          });
        }
      } else {
        const { type, provider, providerSequence } = event;
        broadcast({ type: "event", t: at(), event: { type, provider, providerSequence, ...(event.format && { format: event.format }), ...(event.reason && { reason: event.reason }) } });
      }
    }
  })();

  // Twilio wire protocol, exactly as Twilio would send it.
  session.receive(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
  session.receive(
    JSON.stringify({
      event: "start",
      sequenceNumber: "1",
      streamSid,
      start: { accountSid: "ACdemo", streamSid, callSid, tracks: ["inbound"], customParameters: { tenant: "acme" }, mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 } },
    }),
  );
  broadcast({ type: "pipeline", status: pipeline.status(), capabilities: summarize(session.capabilities()) });

  // Synthetic caller audio: voiced bursts while speaking, low noise otherwise.
  let seq = 2;
  let chunk = 1;
  let speakingUntil = 0;
  let phase = 0;
  const audioTimer = setInterval(() => {
    const now = at();
    const speaking = now < speakingUntil;
    const samples = new Array(160);
    for (let i = 0; i < 160; i++) {
      const t = (now + i / 8) / 1000;
      const syllable = speaking ? Math.abs(Math.sin(2 * Math.PI * 3.2 * t)) : 0;
      phase += (2 * Math.PI * 165) / 8000;
      const voice = syllable * (Math.sin(phase) * 0.6 + Math.sin(2 * phase) * 0.3 + Math.sin(3 * phase) * 0.1);
      samples[i] = Math.round(voice * 9000 + (Math.random() - 0.5) * 500);
    }
    const payload = Buffer.from(encodeMulaw(samplesToPcm16(samples))).toString("base64");
    session.receive(
      JSON.stringify({ event: "media", sequenceNumber: String(seq++), streamSid, media: { track: "inbound", chunk: String(chunk++), timestamp: String(now), payload } }),
    );
  }, 20);

  const handleTranscript = async (event) => {
    broadcast({ type: "transcript", t: at(), kind: event.kind, turnId: event.turnId, revision: event.revision, text: event.text });
    for (const result of await email.handle(event)) broadcast({ type: "email", t: at(), result, state: await stateOf(email, callSid) });
    const context = await rag.handle(event);
    if (context) {
      broadcast({
        type: "rag",
        t: at(),
        query: context.query,
        status: context.status,
        droppedForAccess: context.droppedForAccess,
        citations: context.items.map((i) => ({ ...i.citation, text: i.text })),
        prompt: formatContext(context),
      });
    }
  };

  const stt = async (result) => {
    for (const e of reconciler.accept(result)) await handleTranscript(e);
  };

  let segmentKey = 0;
  for (const step of SCRIPT) {
    await sleep(Math.max(0, step.at - at()));
    if (step.agent) {
      broadcast({ type: "agent", t: at(), text: step.agent });
      if (step.asks) {
        await email.questionAsked("acme", callSid);
        broadcast({ type: "email", t: at(), result: { type: "question_asked" }, state: await stateOf(email, callSid) });
      }
    }
    if (step.speak) {
      speakingUntil = at() + step.speak;
      const parts = step.interim ?? [];
      for (const [i, text] of parts.entries()) {
        await sleep(step.speak / (parts.length + 1));
        await stt({ type: "interim", text, confidence: null });
      }
      await sleep(Math.max(0, speakingUntil - at()));
      for (const text of step.segments ?? [step.final]) {
        await stt({ type: "segment_final", text, confidence: 0.93, segmentKey: `seg-${segmentKey}`, startMs: segmentKey++ * 1000 });
      }
      await stt({ type: "turn_end" });
      if (step.confirms) {
        for (const result of await email.confirm("acme", callSid)) broadcast({ type: "email", t: at(), result, state: await stateOf(email, callSid) });
      }
    }
    if (step.end) {
      clearInterval(audioTimer);
      session.receive(JSON.stringify({ event: "stop", sequenceNumber: String(seq++), streamSid, stop: { accountSid: "ACdemo", callSid } }));
      for (const f of pipeline.flush()) frames++;
      await consume;
      broadcast({ type: "metrics", frames, avgMicros: processingMicros / Math.max(1, frames), dropped: session.droppedAudioFrames });
      broadcast({ type: "call", phase: "end", callSid, durationMs: at() });
    }
  }
}

async function stateOf(email, callSid) {
  const { status, email: confirmed, candidate } = await email.getState("acme", callSid);
  return { status, email: confirmed, candidate };
}

function summarize(caps) {
  return Object.fromEntries(Object.entries(caps.capabilities).map(([k, v]) => [k, v.support]));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function loop() {
  for (;;) {
    try {
      await runCall();
    } catch (err) {
      broadcast({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
    await sleep(3000);
  }
}

createServer(async (req, res) => {
  if (req.url === "/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write("retry: 2000\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(await readFile(page));
    return;
  }
  res.writeHead(404).end();
}).listen(PORT, () => {
  console.log(`Live call dashboard: http://localhost:${PORT}`);
  void loop();
});
