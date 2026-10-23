# Root cause analysis

**Basis:** no existing calling-agent codebase was available to audit (greenfield, 2026-10-23). The causes below are the failure mechanisms the toolkit is designed against. They are **hypotheses**. When the toolkit is integrated with a real agent, confirm each one against that agent's logs and transcripts and record the evidence here.

## 1. Email is missed when the caller skips the question or gives it later

| Suspected cause | Why it loses the email | Toolkit response (phase) — status |
|---|---|---|
| Capture runs only inside the "ask for email" turn | An address volunteered earlier or later is never parsed | Capture listens to every committed transcript, not only the prompted turn (4) — done |
| A skip or refusal ends the slot permanently | The caller says "I'll give it later" and is never asked again | The refusal is recorded; a later spontaneous address is still accepted (4) — done |
| Partial STT hypotheses are concatenated | "john dot" + "john dot smith at" produces duplicated or garbled text | Reconcile partial, revised and final transcript events by turn id before parsing (5) — done |
| Spoken forms are not normalized | "john underscore smith at gmail dot com" fails a regex | Normalize "at", "dot", "underscore", "hyphen" and spelled letters (4) — done |
| An uncertain parse overwrites a confirmed value | A later mis-hearing replaces a good address | A confirmed email is replaced only by an explicit correction (4) — done |
| No ambiguity signal | Missing characters are guessed instead of asked about | Emit a clarification-needed result. The host speaks the prompt (4) — done |

## 2. Noise and background speakers degrade STT

| Suspected cause | Effect | Toolkit response (phase) — status |
|---|---|---|
| Enhancement is applied to a different stream than the one STT reads | Suppression "is on" but STT hears raw audio | Enhancement sits in the same pipeline that feeds the STT adapter, and tests assert it (4–5) — done |
| Repeated or incorrect transcoding (μ-law ↔ PCM ↔ resample) | Added distortion and latency | Decode once to PCM16, resample once, and keep provider format metadata on every frame (2, 4) — done |
| Stacked aggressive denoisers (provider + toolkit + STT) | Quiet speech and spelled letters are removed | Provider-native suppression is a separate, reported capability, and the toolkit warns when both are active (3–4) — done |
| Background speech treated as noise | Generic denoisers keep other voices | Speaker isolation is a separate optional stage, only where an engine supports it (4) — interface done, no engine bundled |
| Unbounded buffers under load | Latency grows until turns desynchronize | Bounded queues with explicit drop/reject policies (2) — done |

All mitigations above are implemented and covered by shared fixtures. Whether they fix the problem in production still has to be confirmed against a real agent's calls.
