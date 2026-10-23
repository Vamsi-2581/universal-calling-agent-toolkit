# Adapter development

This guide covers adding a telephony provider without changing the core. The Twilio and Plivo adapters (`packages/*/providers/`) are worked examples of everything below.

For JSON-over-WebSocket protocols, extend `BaseMediaSession`. It already provides the state machine, bounded queue, size limits, audio dropping, idempotent close and capability-checked sends. A subclass only translates messages.

## 1. Decide what the provider actually offers

Read the provider's current official docs and answer:
- Does it expose call control (REST/webhooks)?
- Does it expose live media? Over what transport, in which directions, and can you play audio back?
- What codecs and sample rates does it use? What do its timestamps mean?
- How are webhooks and stream connections authenticated?

If there is no live audio path, implement only `CallControlAdapter` and register the provider with `media: null`. A recording-based workflow belongs in the batch integration (Phase 7), not in a fake media adapter.

## 2. Declare every capability

Start from all capabilities set to `unsupported`, then raise each one you have implemented and tested. Use `requires_configuration` with a `note` when support depends on how the stream was started.

```ts
const capabilities: ProviderCapabilities = {
  provider: "acme",
  adapterVersion: "0.1.0",
  capabilities: {
    ...Object.fromEntries(CAPABILITIES.map((c) => [c, { support: "unsupported" }])),
    live_inbound_audio: { support: "supported" },
    playback: { support: "requires_configuration", note: "Start the stream with bidirectional=true." },
    recording_access: { support: "unavailable_from_provider" },
  },
};
```

```python
caps = {c: CapabilityEntry("unsupported") for c in CAPABILITIES}
caps["live_inbound_audio"] = CapabilityEntry("supported")
```

`ProviderRegistry.register` rejects adapters that leave capabilities undeclared, and rejects live-audio claims without a media adapter.

## 3. Call control

Extend `BaseCallControlAdapter` (TS) or `BaseCallControlAdapter` (Python) and override only what you implement. Every method you leave alone raises a typed error:
- `unsupported_capability` if the capability is declared unsupported;
- an "adapter bug" error if it is declared supported but not implemented.

`validateWebhook` must use the provider's official signature scheme on the raw URL and body in `WebhookRequest`. Raise `ProviderError({ code: "signature_invalid" })` on failure.

## 4. Media transport

Implement `MediaTransportAdapter.createSession(connection)` returning a `MediaSession`:

- `receive(message)` parses exactly one provider message:
  1. Convert provider strings or numbers to integers. Twilio sends `"3"`, Plivo sends `3`.
  2. Map MIME types to `AudioEncoding` (`audio/x-mulaw` → `mulaw`, `audio/x-l16` → `pcm_s16le`). Check L16 byte order against the provider's docs before assuming little-endian.
  3. Set `timestampKind` to match the provider's clock.
  4. Run `validateAudioPayload` before enqueueing.
  5. Push normalized `TelephonyEvent`s into a `BoundedQueue`: `drop_oldest` for audio, `reject` for control events.
  6. Raise `malformed_message` or `protocol_violation` for bad input. Never drop it silently.
- Outbound methods (`sendAudio`, `sendMark`, `clearPlayback`, `sendDtmf`) call `requireCapability` first, then format the provider's message and call `connection.sendText`.
- `close()` closes the queue and connection, and is idempotent.

Vendor event names (`playedStream`, `clearedAudio`, `mark`) must not leak past the adapter. They become `playback_mark` and `playback_cleared`.

## 5. Fixtures and tests

- Add raw protocol messages under `contracts/fixtures/providers/<name>/`, taken from the provider's documentation, with the source URL in the fixture's `description`.
- Every normalized event your adapter emits must validate against `TelephonyEvent` in `core.schema.json`.
- Run the conformance suite and update [PROVIDER_COMPATIBILITY.md](PROVIDER_COMPATIBILITY.md) with honest statuses:

```ts
import { mediaConformanceChecks } from "@vasikmansuri/calling-agent-toolkit";
for (const check of mediaConformanceChecks(myTarget)) it(check.name, check.run);
```

```python
from calling_agent_toolkit import media_conformance_checks

@pytest.mark.parametrize("check", media_conformance_checks(my_target), ids=lambda c: c.name)
async def test_conformance(check): await check.run()
```
