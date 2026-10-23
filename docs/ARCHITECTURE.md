# Architecture

Status: all ten phases built and tested offline, but not published and not run against live provider accounts. See [PROVIDER_COMPATIBILITY.md](PROVIDER_COMPATIBILITY.md) for exactly what each provider supports, and [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) for what remains before release.

## Scope

The toolkit is a set of components that an existing calling agent plugs in. It does not own the call flow, prompts, LLM, conversation engine, or web server. Every module takes normalized input and returns normalized output, and the host application decides what to do with it.

```
provider call control ──► (webhooks, REST)         ┐
provider media transport ─► normalized TelephonyEvent / AudioFrame
        │
        ▼
codec decode ► format validation ► framing ► noise suppression ► (optional) speaker isolation
        │
        ▼
STT adapter ► normalized transcript events ► email capture / RAG trigger
        │
        ▼
host calling application (owns prompts, LLM, business rules, what to say)
```

Audio from Twilio, Plivo, a SIP gateway or a prerecorded file enters the same pipeline. Everything after the media adapter is provider-independent.

## Packages

| Path | Distribution | Runtime deps |
|---|---|---|
| `packages/typescript` | `@vasikmansuri/calling-agent-toolkit` (npm, ESM) | none |
| `packages/python` | `calling-agent-toolkit` (PyPI) | none |
| `contracts/` | not published; consumed by both test suites | — |

Neither package needs the other runtime. Provider SDKs, native audio engines, ML models and RAG frameworks will be optional extras (`[project.optional-dependencies]` in Python, separate packages or optional peer deps in npm). They will be added only when a verified adapter needs them.

The npm package ships ESM only for now. CommonJS output is added only if a real consumer needs it.

## Core contracts

Both packages implement the same types, defined once in [`contracts/schemas/core.schema.json`](../contracts/schemas/core.schema.json):

| Type | Purpose |
|---|---|
| `AudioFormat` | `encoding` (`pcm_s16le`, `mulaw`, `alaw`), `sampleRate`, `channels`. Provider MIME strings never appear here. |
| `AudioFrame` | Call/session ids, provider, `direction`, format, payload, `timestampMs` with an explicit `timestampKind`, `sequenceNumber`, `chunk`, and `isCompleteFrame`. |
| `MediaDirection` | `inbound` (from the remote party) or `outbound` (toward the remote party). |
| `ProviderCapabilities` | Every `Capability` declared as `supported`, `unsupported`, `requires_configuration` or `unavailable_from_provider`. |
| `TelephonyEvent` | Normalized events: `stream_started`, `audio`, `dtmf`, `playback_mark`, `playback_cleared`, `stream_stopped`, `call_status`, `error`. |
| `ProviderError` | Typed error with a fixed `code` set, `retryable`, optional `capability` and native `providerCode`. |
| `AdapterHealth` | `healthy` / `degraded` / `unhealthy` plus active session count. |

Language mapping: TypeScript uses camelCase interfaces directly. Python uses frozen dataclasses with snake_case fields, and its wire helpers (`frame_to_wire`, `ProviderError.to_dict`) emit the schema's camelCase.

### Why `timestampKind` exists

Twilio's `media.timestamp` is milliseconds since the stream started. Plivo's documented `media.timestamp` is Unix epoch milliseconds. A single numeric field would make cross-provider code silently compare unrelated clocks, so the kind travels with the value and `none` forces `timestampMs` to be `null`.

## Telephony: call control is separate from media

- **`CallControlAdapter`**: REST and webhook operations. It covers outbound calls, ending and transferring calls, DTMF, starting and stopping media streams, and webhook validation and parsing.
- **`MediaTransportAdapter`**: validates an incoming stream connection and creates a `MediaSession` that parses provider messages into normalized events and sends playback, marks, clears and DTMF back.
- **`TelephonyProvider`**: `{ name, callControl | null, media | null }`. A provider with call control but no live media is represented explicitly. `ProviderRegistry` refuses a provider that claims live audio without a media adapter.

The toolkit never opens HTTP or WebSocket servers. The host passes in its existing socket as a `MediaConnection` (`sendText`, `close`) and feeds raw messages to `MediaSession.receive()`. This keeps the toolkit compatible with any web framework.

### Capability negotiation

- Built-in adapters must declare every capability. `ProviderRegistry.register` rejects undeclared ones.
- `requireCapability(caps, capability)` is called before every optional operation:
  - `requires_configuration` → `invalid_configuration`, with the adapter's note. For example: "Start the stream in bidirectional mode."
  - `unsupported` or `unavailable_from_provider` → `unsupported_capability`.
  - undeclared → `unsupported_capability`.
- `BaseCallControlAdapter` implements every operation as a capability check followed by an "adapter bug" error. A forgotten override can never silently no-op.

Provider-native features such as Plivo's `noise_cancellation` are exposed through the `provider_noise_suppression` capability and `MediaStreamRequest.providerOptions`. They are reported separately from the toolkit's own audio pipeline.

### Buffering and backpressure

`BoundedQueue` is the only buffer primitive. It has a fixed capacity and one of two overflow policies:
- `drop_oldest` for realtime audio, where latency matters more than completeness. The queue counts drops.
- `reject` for control events, where it raises `buffer_overflow`.

Payload sizes are checked by `validateAudioPayload` against a configurable byte limit and the sample width.

## Audio normalization (current state)

Implemented in both languages:
- the G.711 μ-law codec, bit-exact with CPython `audioop` over all 256 codes;
- payload size and sample-alignment validation;
- a supported sample-rate set (8, 16, 24 and 48 kHz).

Resampling, framing and the processor chain are covered in [AUDIO_PIPELINE.md](AUDIO_PIPELINE.md). No noise-suppression engine is bundled yet. A-law is accepted by adapters (Telnyx PCMA, WAV) but has no codec, so the pipeline raises `unsupported_format` for it.

## Security posture

- Credentials are passed as `SecretResolver` functions resolved at use time, never stored as strings on config objects.
- Webhook validation receives the raw URL, headers and body (`WebhookRequest`), which is what signature schemes need.
- No module logs payloads, transcripts or email addresses. Errors carry ids and codes, not content.

The full write-up lands in `SECURITY.md` with the Phase 3 webhook-validation work.

## Phase plan and documents

| Phase | Deliverable | Docs |
|---|---|---|
| 1–2 | contracts, core types, codec, queue, registry | ARCHITECTURE, PROVIDER_COMPATIBILITY, ROOT_CAUSE_ANALYSIS, ADAPTER_DEVELOPMENT, TESTING |
| 3 | Twilio and Plivo media adapters, signatures, REST call control, conformance suite | SECURITY |
| 4 | email capture, audio pipeline | EMAIL_CAPTURE, AUDIO_PIPELINE |
| 5 | STT contracts, reconciler, Deepgram adapter | STT_INTEGRATION |
| 6 | RAG: safe retriever, coordinator, LangChain/LlamaIndex wrappers | RAG_INTEGRATION |
| 7 | generic JSON WebSocket, raw PCM, RTP, WAV/batch | ADAPTER_DEVELOPMENT |
| 8 | Telnyx and Vonage adapters | PROVIDER_COMPATIBILITY |
| 9 | end-to-end examples, benchmarks, packaging checks | TESTING |
| 10 | release workflow (manual, gated), checklist, changelog, licence | RELEASE_CHECKLIST |
