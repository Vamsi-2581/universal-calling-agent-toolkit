# STT integration

## Contracts

- **`SttResult`:** what a provider adapter emits, already normalized:
  - `interim` (may still change);
  - `segment_final` (committed text, with a provider-stable `segmentKey` and optional `startMs`);
  - `turn_end` (the speaker finished).
  Confidence is `null` when the provider gives none. It is never invented.
- **`StreamingSttSession` / `StreamingSttAdapter`, `BatchSttAdapter`:** provider-neutral session and adapter interfaces.
- **`TranscriptReconciler`:** turns `SttResult`s into `TranscriptEvent`s for email capture and RAG:
  - interim text is shown on top of committed segments as `partial` events, and is never committed;
  - segment finals are de-duplicated by `segmentKey` and ordered by `startMs`;
  - each turn ends with exactly one `final` event (`revision 0`), whose confidence is the minimum segment confidence (or `null` if any segment lacks one);
  - a `turn_end` with no committed text emits nothing, so double end-of-speech signals are harmless.
- **`SttAudioBridge`:** feeds pipeline output to an STT session and enforces matching formats.

## Provider adapters

| Provider | Status | Notes |
|---|---|---|
| Deepgram live (`/v1/listen`) | **implemented, not integration-tested** | Message mapping follows Deepgram's docs: `Results` with `is_final=false` → `interim`; `is_final=true` → `segment_final` (key = start:duration in ms); `speech_final=true` → also `turn_end`; `UtteranceEnd` → `turn_end`. `deepgramListenUrl` builds the URL and enforces Deepgram's rule that `utterance_end_ms` needs `interim_results=true`. The host opens the socket with `Authorization: Token <key>`, so keys never pass through the toolkit |
| OpenAI transcription, Google Cloud STT, Azure Speech, Amazon Transcribe, ElevenLabs, local engines | planned | Not implemented; each needs its API verified first. The `SttResult` contract is designed so their final/interim models map onto it |

Deepgram's `KeepAlive` and `CloseStream` messages are sent as `{"type":"KeepAlive"}` and `{"type":"CloseStream"}`. These two message shapes come from Deepgram's SDK conventions, not from the two documentation pages reviewed. Verify them with a live key before production use.

## Verified end to end (fixtures)

- **Audio reaches STT:** the bytes sent to the STT socket equal the processed pipeline frames (`stt.test.ts`, `test_stt.py`).
- **Email from fragments:** an address spoken across two Deepgram segments is captured as one candidate (`john.smith@gmail.com`).
