# Security

Status: all phases built; not yet audited externally. Report vulnerabilities privately to the maintainers. Do not open public issues for them.

## Webhook and stream authentication

| Provider | Mechanism | Implementation | Reference |
|---|---|---|---|
| Twilio webhooks | `X-Twilio-Signature`: HMAC-SHA1 of the exact URL plus sorted, de-duplicated POST params, keyed by the auth token. JSON bodies are covered by a `bodySHA256` query param. The URL is tried with and without the default port. | `validateTwilioRequest` / `validate_twilio_request` | twilio-python `RequestValidator`; fixtures generated from it |
| Twilio Media Streams handshake | Lowercase `x-twilio-signature` on the WebSocket upgrade | `TwilioMediaTransport.validateConnection` | Same algorithm. The exact URL Twilio signs for the handshake is not yet verified against a live stream. |
| Plivo callbacks | `X-Plivo-Signature-V3`: HMAC-SHA256 over the method-specific base URL and the nonce. The header may list several signatures. | `validatePlivoRequest` / `validate_plivo_request` | plivo-python `signature_v3`; fixtures generated from it |
| Telnyx stream handshake | **Not described in Telnyx's streaming docs** | Host-supplied `connectionValidator` | As for Plivo |
| Vonage WebSocket handshake | `Authorization`: a custom value, or `Bearer` HS256 JWT signed with the signature secret | `VonageMediaTransport` (`authorization` option), `verifyVonageJwt` | `alg` must be HS256; `iat` is required and must fall within `maxAgeSeconds` (default 300); `exp` and `nbf` are honoured |
| Plivo Audio Streams handshake | **Not documented by Plivo** | Host-supplied `connectionValidator`. Until one is supplied, `stream_auth_validation` is `requires_configuration`. | Put a per-call secret in the stream URL or `extraHeaders` and check it in the validator |

Rules:
- Always pass the **raw** request URL and body (`WebhookRequest.rawBody`). Re-serializing parsed params, or re-encoding the URL, breaks signatures.
- Behind a proxy, reconstruct the public URL Twilio or Plivo called (scheme, host and path), not the internal one.
- All signature comparisons are constant-time (`timingSafeEqual` / `hmac.compare_digest`).
- Validation helpers return `false` and never throw on hostile input. Adapters turn that into `signature_invalid` or `authentication_failed`.

## Credentials

- **REST call control:** the auth token is resolved per request and sent only in the `Authorization: Basic` header. A test asserts that the token appears nowhere else in the request. Account SIDs and auth IDs are not secret.
- **STT keys:** the Deepgram adapter never sees the API key. The host opens the socket with its own header.

- Adapters take credentials as `SecretResolver` functions (`() => Promise<string>`), resolved on each use. No adapter stores a token string on a config object, and `ProviderError` never includes one.
- Test fixtures use obviously fake tokens (`*-test-token-not-real`).
- `.gitignore` excludes `.env*`. Published artifacts contain only `dist/` (npm) and the `calling_agent_toolkit` package (PyPI).

## Untrusted input limits

Provider messages are untrusted. Each media session enforces:

| Limit | Default | Option |
|---|---|---|
| Raw message size | 1 MiB | `maxMessageBytes` / `max_message_bytes` |
| Decoded audio payload | 64 KiB | `maxPayloadBytes` / `max_payload_bytes` |
| Queued events | 500 | `maxQueuedEvents` / `max_queued_events` |

Further protections:
- Malformed JSON, invalid UTF-8, bad base64, wrong field types, unknown tracks, messages for another stream, and messages out of order all raise typed errors without changing session state.
- When the queue is full, audio is dropped and counted, and control events raise `buffer_overflow`. Memory stays bounded either way.

## Privacy

- No module logs audio, transcripts, DTMF digits, phone numbers or email addresses. Errors carry codes and ids only.
- Plivo `extra_headers` and Twilio `customParameters` are passed through to the host as given. Don't put secrets you wouldn't want in your own logs there.
- Recording consent and data retention stay the host's responsibility. The toolkit does not persist audio.
