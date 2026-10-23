// End-to-end example: recording -> audio pipeline -> STT -> transcript -> email capture + RAG.
// Run after `npm run build` in packages/typescript:  node examples/typescript/end-to-end.mjs
//
// A scripted STT session stands in for a real provider so this runs without an API key. Swap it for
// DeepgramStreamingSession (see packages/typescript/src/providers/deepgram.ts) in a real deployment.
import {
  AudioPipeline,
  EmailCapture,
  InMemoryRetriever,
  RetrievalCoordinator,
  SafeRetriever,
  SttAudioBridge,
  TranscriptReconciler,
  fileFrames,
  formatContext,
  readWav,
  writeWavPcm16,
} from "../../packages/typescript/dist/index.js";

class ScriptedSttSession {
  constructor(results) {
    this.scripted = results;
    this.framesReceived = 0;
    this.bytesReceived = 0;
  }
  async sendAudio(frame) {
    this.framesReceived++;
    this.bytesReceived += frame.payload.byteLength;
  }
  async finish() {}
  async close() {}
  async *results() {
    yield* this.scripted;
  }
}

// 1. A one-second 8 kHz recording (silence) stands in for call audio.
const wav = readWav(writeWavPcm16(new Uint8Array(8000 * 2), 8000));

// 2. The same pipeline live calls use: decode, resample to 16 kHz, 20 ms frames, processors.
const pipeline = new AudioPipeline({ targetSampleRate: 16000 });
const stt = new ScriptedSttSession([
  { type: "segment_final", text: "my email is john dot smith at gmail dot com", confidence: 0.92, segmentKey: "0:2100", startMs: 0 },
  { type: "turn_end" },
  { type: "segment_final", text: "what are your support hours", confidence: 0.95, segmentKey: "2500:1400", startMs: 2500 },
  { type: "turn_end" },
]);
const bridge = new SttAudioBridge(pipeline, stt, pipeline.targetFormat);
for (const frame of fileFrames(wav, { callId: "demo-call", sessionId: "demo-call" })) await bridge.push(frame);
await bridge.end();

// 3. Transcript reconciliation, email capture and retrieval.
const reconciler = new TranscriptReconciler({ tenantId: "acme", sessionId: "demo-call" });
const email = new EmailCapture();
const kb = new InMemoryRetriever();
kb.upsert([
  {
    id: "faq-hours",
    documentId: "faq",
    tenantId: "acme",
    text: "Support hours are 9am to 5pm, Monday to Friday.",
    metadata: {},
    acl: null,
    source: { title: "Support FAQ", uri: "kb://faq#hours", page: null },
  },
]);
const rag = new RetrievalCoordinator(new SafeRetriever(kb), { tenantId: "acme", principal: { id: "caller", groups: [] } });

const summary = { pipeline: pipeline.status(), sttFramesReceived: 0, sttBytesReceived: 0, finals: [], email: [], rag: [] };
for await (const result of stt.results()) {
  for (const event of reconciler.accept(result)) {
    if (event.kind === "final") summary.finals.push(event.text);
    summary.email.push(...(await email.handle(event)));
    const context = await rag.handle(event);
    if (context) summary.rag.push({ status: context.status, citations: context.items.map((i) => i.citation), prompt: formatContext(context) });
  }
}
summary.sttFramesReceived = stt.framesReceived;
summary.sttBytesReceived = stt.bytesReceived;
console.log("STT: scripted stand-in (no provider API was called)");
console.log(JSON.stringify(summary, null, 2));
