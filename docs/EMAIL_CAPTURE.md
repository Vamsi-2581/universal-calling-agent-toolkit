# Email capture

`EmailCapture` consumes normalized `TranscriptEvent`s, never vendor messages, and returns results that tell your agent what to do next. It never speaks and never prompts.

## Wiring

```ts
const capture = new EmailCapture({ store, minConfidence: 0.5 });
// when your agent asks for the email:
await capture.questionAsked(tenantId, sessionId);
// for every transcript event (finals are processed; partials are ignored):
for (const result of await capture.handle(event)) {
  switch (result.type) {
    case "candidate":            /* read back result.email and ask the caller to confirm */ break;
    case "clarification_needed": /* ask about result.reason, e.g. "which domain?" */ break;
    case "declined":             /* respect it; result.deferred = "later" */ break;
    case "kept_confirmed":       /* a different address was heard but the confirmed one was kept */ break;
  }
}
await capture.confirm(tenantId, sessionId);  // caller said yes
await capture.reject(tenantId, sessionId);   // caller said no; status returns to "asked"
```

## Behaviour

| Requirement | Behaviour |
|---|---|
| Capture when first spoken | Every final utterance is scanned, not only the turn after the question |
| Skipped question / refusal | After `questionAsked`, "skip", "rather not", "no thanks" and similar give `declined`. Refusal words are ignored when no question was asked |
| Later capture | A declined session still accepts an address volunteered later |
| Duplicates | Repeated `eventId`s, and revisions not higher than the last seen for a turn, are dropped |
| Partial / revised hypotheses | Partials are ignored. A higher `revision` of the same turn replaces that turn's candidate |
| Spoken forms | "at" / "at the rate (of)" / "at sign" → `@`; "dot" / "period" / "point" / "full stop" → `.`; "underscore", "hyphen", "dash", "plus"; digit words; spelled letters ("j o h n"); "s as in sam" |
| Never invent characters | Missing domain, missing local part, dangling separator, one-letter TLD, or two plain words before "at" all give `clarification_needed` with what was heard |
| Confirmed protection | Once confirmed, a different address is reported as `kept_confirmed` unless the utterance is an explicit correction ("actually", "correction", "change it", "instead", "wrong", …) |
| Low STT confidence | Below `minConfidence` gives `clarification_needed` / `low_confidence` |
| Persistence | `EmailStateStore` (async get/set/delete) holding JSON state. Two engines sharing a store see the same session |
| Isolation | State is keyed by `(tenantId, sessionId)`; per-key locks serialize concurrent events |

Clarifications are only reported when the utterance mentions email, mail or address. "I'm at home" or "we met at noon dot com" are ignored, not turned into prompts.

## Known limits

- English spoken conventions only.
- No homophone or letter-confusion handling ("b" vs "d"). Read-back confirmation is the safeguard.
- Ambiguity is resolved by asking, never by guessing. A caller who says "john smith at gmail dot com" is asked which part is the address.

Behaviour is pinned by `contracts/fixtures/email/extraction.json` (24 cases) and `sessions.json` (11 multi-step cases), shared by both languages.
