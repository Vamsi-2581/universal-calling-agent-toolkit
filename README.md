# Universal Calling Agent Toolkit

Reusable building blocks for **existing** AI calling agents: provider-neutral telephony adapters, audio normalization and enhancement, reliable email capture, STT and RAG integration interfaces. It ships as independent Python and TypeScript packages.

This is not a calling agent. It does not replace your conversation engine, telephony stack, STT or RAG framework.

## Status

**All ten phases are built and tested offline. Nothing is published, and no adapter has been run against a live provider account yet.**

| Area | State |
|---|---|
| Shared JSON Schema contracts and cross-language fixtures | done |
| Core: types, errors, capability negotiation, registry, bounded queues, μ-law codec | done |
| Twilio: Media Streams, signatures, REST call control | done, fixture-tested |
| Plivo: Audio Streams, signature V3, REST call control (incl. native noise cancellation) | done, fixture-tested |
| Telnyx media streaming; Vonage WebSockets (with JWT handshake auth) | done, fixture-tested |
| Generic JSON WebSocket, raw PCM, RTP (SIP gateways / Asterisk), WAV batch | done |
| Audio pipeline: decode, resample, framing, processor chain with honest status | done (no noise-suppression engine bundled yet) |
| Email capture | done |
| STT: contracts, transcript reconciler, Deepgram live adapter | done (Deepgram fixture-tested) |
| RAG: safe retriever, retrieval coordinator, LangChain/LlamaIndex wrappers | done (LangChain tested against real `langchain-core`) |
| Examples, benchmarks, packaging checks | done |
| npm / PyPI release | prepared; **locked until you approve** ([checklist](docs/RELEASE_CHECKLIST.md)) |

Tests: 268 (TypeScript) and 271 (Python), sharing one set of fixtures. See [docs/TESTING.md](docs/TESTING.md).

## Quick look

```ts
import { AudioPipeline, SttAudioBridge } from "@vasikmansuri/calling-agent-toolkit";
import { TwilioMediaTransport } from "@vasikmansuri/calling-agent-toolkit/twilio";

const session = new TwilioMediaTransport({ authToken: () => secrets.get("TWILIO_AUTH_TOKEN") })
  .createSession({ sendText: async (d) => ws.send(d), close: async () => ws.close() }, { bidirectional: true });
ws.on("message", (data) => session.receive(data.toString()));

const pipeline = new AudioPipeline({ targetSampleRate: 16000, processors: [/* your noise suppressor */] });
const bridge = new SttAudioBridge(pipeline, sttSession, pipeline.targetFormat);
for await (const event of session.events()) {
  if (event.type === "audio") await bridge.push(event.frame);
}
```

Run the end-to-end examples in [examples/](examples/): recording → pipeline → STT → email capture and RAG.

## Layout

```
contracts/          JSON Schema + shared fixtures (both languages run them)
packages/typescript @vasikmansuri/calling-agent-toolkit — entry points: . ./twilio ./plivo ./telnyx ./vonage ./deepgram
packages/python     calling-agent-toolkit — calling_agent_toolkit.providers.{twilio,plivo,telnyx,vonage,deepgram}
examples/           end-to-end examples (TS + Python)
benchmarks/         micro-benchmarks (TS + Python)
adapters/ integrations/ tests/   pointers only; code ships inside each package
docs/               architecture, compatibility, adapters, audio, email, STT, RAG, security, testing, release
```

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [Provider compatibility](docs/PROVIDER_COMPATIBILITY.md): what works, what doesn't, and what is unverified
- [Adapter development](docs/ADAPTER_DEVELOPMENT.md)
- [Audio pipeline](docs/AUDIO_PIPELINE.md)
- [Email capture](docs/EMAIL_CAPTURE.md)
- [STT integration](docs/STT_INTEGRATION.md)
- [RAG integration](docs/RAG_INTEGRATION.md)
- [Security](docs/SECURITY.md)
- [Testing and benchmarks](docs/TESTING.md)
- [Root cause analysis](docs/ROOT_CAUSE_ANALYSIS.md)
- [Release checklist](docs/RELEASE_CHECKLIST.md)

Licensed under Apache-2.0.
