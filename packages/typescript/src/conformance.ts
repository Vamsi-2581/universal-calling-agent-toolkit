import type { MediaConnection, MediaSession, MediaSessionOptions, MediaTransportAdapter } from "./adapters.js";
import { undeclaredCapabilities } from "./capabilities.js";
import { ProviderError, type ProviderErrorCode } from "./errors.js";
import type { AudioFormat, TelephonyEvent } from "./types.js";

/** In-memory MediaConnection that records what an adapter sends. */
export class RecordingConnection implements MediaConnection {
  readonly sent: string[] = [];
  readonly binary: Uint8Array[] = [];
  closeCount = 0;

  async sendText(data: string): Promise<void> {
    this.sent.push(data);
  }

  async sendBinary(data: Uint8Array): Promise<void> {
    this.binary.push(data);
  }

  async close(): Promise<void> {
    this.closeCount++;
  }
}

export interface StreamIds {
  readonly callId: string;
  readonly sessionId: string;
}

/** What the conformance suite needs to drive a JSON media adapter without knowing its protocol. */
export interface MediaConformanceTarget {
  readonly name: string;
  createAdapter(): MediaTransportAdapter;
  /** Normalized format announced by startMessage. */
  readonly inputFormat: AudioFormat;
  /** Extra options needed for the start message to be accepted (e.g. a byte order). */
  readonly sessionOptions?: MediaSessionOptions;
  startMessage(ids: StreamIds): string;
  /** A one-track media message carrying payloadBase64, already in inputFormat byte layout. */
  mediaMessage(ids: StreamIds, payloadBase64: string, sequence: number): string;
  /** Provider's in-band stop message, when the protocol documents one. */
  stopMessage?(ids: StreamIds): string;
}

export interface ConformanceCheck {
  readonly name: string;
  run(): Promise<void>;
}

class ConformanceError extends Error {
  override name = "ConformanceError";
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ConformanceError(message);
}

function expectCode(fn: () => unknown, codes: readonly ProviderErrorCode[], what: string): void {
  try {
    fn();
  } catch (err) {
    check(err instanceof ProviderError, `${what}: expected ProviderError, got ${String(err)}`);
    check(codes.includes(err.code), `${what}: expected ${codes.join(" or ")}, got ${err.code}`);
    return;
  }
  throw new ConformanceError(`${what}: expected ${codes.join(" or ")}, but nothing was thrown`);
}

async function expectCodeAsync(fn: () => Promise<unknown>, codes: readonly ProviderErrorCode[], what: string) {
  try {
    await fn();
  } catch (err) {
    check(err instanceof ProviderError, `${what}: expected ProviderError, got ${String(err)}`);
    check(codes.includes(err.code), `${what}: expected ${codes.join(" or ")}, got ${err.code}`);
    return;
  }
  throw new ConformanceError(`${what}: expected ${codes.join(" or ")}, but nothing was thrown`);
}

async function drain(session: MediaSession): Promise<TelephonyEvent[]> {
  const events: TelephonyEvent[] = [];
  for await (const event of session.events()) events.push(event);
  return events;
}

const IDS: StreamIds = { callId: "conformance-call-1", sessionId: "conformance-stream-1" };
const PAYLOAD = Buffer.alloc(8, 0x7f).toString("base64");

/**
 * Framework-agnostic checks every JSON media adapter must pass. Each check throws on failure.
 * Wrap them in your test runner, e.g. `for (const c of mediaConformanceChecks(t)) it(c.name, c.run)`.
 */
export function mediaConformanceChecks(target: MediaConformanceTarget): ConformanceCheck[] {
  const open = (extra: MediaSessionOptions = {}) => {
    const connection = new RecordingConnection();
    const session = target.createAdapter().createSession(connection, { ...target.sessionOptions, ...extra });
    return { connection, session };
  };
  const started = (extra: MediaSessionOptions = {}, ids = IDS) => {
    const opened = open(extra);
    opened.session.receive(target.startMessage(ids));
    return opened;
  };

  const checks: ConformanceCheck[] = [
    {
      name: "declares every capability on the adapter and the session",
      async run() {
        const adapter = target.createAdapter();
        check(undeclaredCapabilities(adapter.capabilities()).length === 0, "adapter leaves capabilities undeclared");
        const { session } = open();
        check(undeclaredCapabilities(session.capabilities()).length === 0, "session leaves capabilities undeclared");
      },
    },
    {
      name: "rejects non-JSON input with malformed_message",
      async run() {
        const { session } = open();
        expectCode(() => session.receive("{not json"), ["malformed_message"], "non-JSON");
        expectCode(() => session.receive(new Uint8Array([0xff, 0xfe])), ["malformed_message"], "invalid UTF-8");
      },
    },
    {
      name: "rejects media before start with protocol_violation",
      async run() {
        const { session } = open();
        expectCode(() => session.receive(target.mediaMessage(IDS, PAYLOAD, 1)), ["protocol_violation"], "early media");
        check(session.state === "awaiting_start", "state changed after a rejected message");
      },
    },
    {
      name: "normalizes start and media into schema events with matching ids and format",
      async run() {
        const { session } = started();
        session.receive(target.mediaMessage(IDS, PAYLOAD, 2));
        await session.close();
        const [start, audio, stop] = await drain(session);
        check(start?.type === "stream_started", "first event is not stream_started");
        check(JSON.stringify(start.format) === JSON.stringify(target.inputFormat), "start format mismatch");
        check(audio?.type === "audio", "second event is not audio");
        check(audio.frame.callId === IDS.callId && audio.frame.sessionId === IDS.sessionId, "frame ids mismatch");
        check(audio.frame.payload.byteLength === 8, "payload length changed");
        check(JSON.stringify(audio.frame.format) === JSON.stringify(target.inputFormat), "frame format mismatch");
        check(stop?.type === "stream_stopped" && stop.reason === "socket_closed", "close did not emit socket_closed");
      },
    },
    {
      name: "enforces maxPayloadBytes with buffer_overflow",
      async run() {
        const { session } = started({ maxPayloadBytes: 4 });
        expectCode(() => session.receive(target.mediaMessage(IDS, PAYLOAD, 2)), ["buffer_overflow"], "oversized payload");
      },
    },
    {
      name: "drops audio instead of throwing when the consumer falls behind",
      async run() {
        const { session } = started({ maxQueuedEvents: 2 });
        for (let i = 2; i < 6; i++) session.receive(target.mediaMessage(IDS, PAYLOAD, i));
        check(session.droppedAudioFrames === 3, `expected 3 dropped frames, got ${session.droppedAudioFrames}`);
      },
    },
    {
      name: "close is idempotent and closes the connection once",
      async run() {
        const { session, connection } = started();
        await session.close();
        await session.close();
        check(connection.closeCount === 1, `connection closed ${connection.closeCount} times`);
        const events = await drain(session);
        check(events.filter((e) => e.type === "stream_stopped").length === 1, "expected exactly one stream_stopped");
        expectCode(() => session.receive(target.mediaMessage(IDS, PAYLOAD, 3)), ["session_closed"], "receive after close");
      },
    },
    {
      name: "keeps concurrent sessions isolated",
      async run() {
        const other: StreamIds = { callId: "conformance-call-2", sessionId: "conformance-stream-2" };
        const a = started();
        const b = started({}, other);
        a.session.receive(target.mediaMessage(IDS, PAYLOAD, 2));
        b.session.receive(target.mediaMessage(other, PAYLOAD, 2));
        await Promise.all([a.session.close(), b.session.close()]);
        const [ea, eb] = await Promise.all([drain(a.session), drain(b.session)]);
        check(ea.every((e) => e.callId === IDS.callId), "session A received foreign events");
        check(eb.every((e) => e.callId === other.callId), "session B received foreign events");
      },
    },
    {
      name: "refuses playback on a unidirectional stream without sending anything",
      async run() {
        const { session, connection } = started({ bidirectional: false });
        await expectCodeAsync(
          () => session.sendAudio(Buffer.from(PAYLOAD, "base64"), target.inputFormat),
          ["unsupported_capability"],
          "sendAudio",
        );
        await expectCodeAsync(() => session.clearPlayback(), ["unsupported_capability"], "clearPlayback");
        check(connection.sent.length === 0, "adapter wrote to the connection despite refusing");
      },
    },
  ];

  const stopMessage = target.stopMessage?.bind(target);
  if (stopMessage) {
    checks.push({
      name: "provider stop ends the event stream",
      async run() {
        const { session } = started();
        session.receive(stopMessage(IDS));
        const events = await drain(session);
        const last = events.at(-1);
        check(last?.type === "stream_stopped" && last.reason === "provider_stop", "last event is not provider_stop");
        expectCode(() => session.receive(target.mediaMessage(IDS, PAYLOAD, 3)), ["session_closed"], "receive after stop");
      },
    });
  }
  return checks;
}
