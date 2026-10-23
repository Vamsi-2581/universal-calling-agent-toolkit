import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  ProviderError,
  ProviderRegistry,
  RecordingConnection,
  eventToWire,
  mediaConformanceChecks,
  type MediaConformanceTarget,
  type MediaSession,
  type MediaTransportAdapter,
  type TelephonyEvent,
} from "../src/index.js";
import { PlivoCallControl, PlivoMediaTransport, validatePlivoRequest } from "../src/providers/plivo.js";
import { TwilioCallControl, TwilioMediaTransport, validateTwilioRequest } from "../src/providers/twilio.js";
import { TelnyxMediaTransport } from "../src/providers/telnyx.js";
import { VonageMediaTransport } from "../src/providers/vonage.js";

const contracts = fileURLToPath(new URL("../../../contracts/", import.meta.url));
const load = (path: string): any => JSON.parse(readFileSync(contracts + path, "utf8"));
const schema = load("schemas/core.schema.json");
const ajv = new Ajv2020({ strict: false });
ajv.addSchema(schema);
const validEvent = ajv.getSchema(`${schema.$id}#/$defs/TelephonyEvent`)!;

const secret = (value: string) => async () => value;

describe.each([
  ["twilio", validateTwilioRequest],
  ["plivo", validatePlivoRequest],
] as const)("%s webhook signatures (reference: official SDK)", (provider, validate) => {
  for (const c of load(`fixtures/providers/${provider}/signatures.json`).cases) {
    it(c.name, () => expect(validate(c.authToken, c.request)).toBe(c.valid));
  }
});

describe("call-control adapters", () => {
  it("raise signature_invalid on a bad webhook and pass a good one", async () => {
    const [good, bad] = load("fixtures/providers/twilio/signatures.json").cases;
    const twilio = new TwilioCallControl({ accountSid: "AC1", authToken: secret(good.authToken) });
    await expect(twilio.validateWebhook(good.request)).resolves.toBeUndefined();
    await expect(twilio.validateWebhook({ ...good.request, rawBody: bad.request.rawBody + "x" })).rejects.toMatchObject({
      code: "signature_invalid",
    });
    const plivoCase = load("fixtures/providers/plivo/signatures.json").cases[0];
    const plivo = new PlivoCallControl({ authId: "MA1", authToken: secret(plivoCase.authToken) });
    await expect(plivo.validateWebhook(plivoCase.request)).resolves.toBeUndefined();
  });

  it("report operations the provider lacks as unsupported", async () => {
    const twilio = new TwilioCallControl({ accountSid: "AC1", authToken: secret("t") });
    await expect(twilio.sendDtmf("CA1", "1")).rejects.toMatchObject({
      code: "unsupported_capability",
      capability: "dtmf_send",
    });
  });

  it("register cleanly with their media adapters", () => {
    const registry = new ProviderRegistry();
    registry.register({ name: "twilio", callControl: new TwilioCallControl({ accountSid: "AC1", authToken: secret("t") }), media: new TwilioMediaTransport() });
    registry.register({ name: "plivo", callControl: new PlivoCallControl({ authId: "MA1", authToken: secret("t") }), media: new PlivoMediaTransport() });
    expect(registry.names()).toEqual(["twilio", "plivo"]);
  });
});

describe("stream handshake validation", () => {
  it("twilio checks x-twilio-signature when an auth token is configured", async () => {
    const ws = load("fixtures/providers/twilio/signatures.json").cases.filter((c: any) => c.name.startsWith("media stream"));
    const transport = new TwilioMediaTransport({ authToken: secret(ws[0].authToken) });
    await expect(transport.validateConnection(ws[0].request)).resolves.toBeUndefined();
    await expect(transport.validateConnection(ws[1].request)).rejects.toMatchObject({ code: "signature_invalid" });
    await expect(new TwilioMediaTransport().validateConnection(ws[0].request)).rejects.toMatchObject({
      code: "invalid_configuration",
    });
  });

  it("plivo requires a host validator", async () => {
    const req = { url: "wss://example.com/media?token=x", headers: {} };
    await expect(new PlivoMediaTransport().validateConnection(req)).rejects.toMatchObject({ code: "invalid_configuration" });
    const transport = new PlivoMediaTransport({ connectionValidator: async (r) => r.url.endsWith("token=x") });
    await expect(transport.validateConnection(req)).resolves.toBeUndefined();
    await expect(transport.validateConnection({ ...req, url: "wss://example.com/media" })).rejects.toMatchObject({
      code: "authentication_failed",
    });
  });
});

async function runAction(session: MediaSession, action: any): Promise<void> {
  switch (action.op) {
    case "sendAudio":
      return session.sendAudio(new Uint8Array(Buffer.from(action.payloadBase64, "base64")), action.format);
    case "sendMark":
      return session.sendMark(action.name);
    case "clearPlayback":
      return session.clearPlayback();
    case "sendDtmf":
      return session.sendDtmf(action.digits);
  }
  throw new Error(`unknown op ${action.op}`);
}

const transports: Record<string, () => MediaTransportAdapter> = {
  twilio: () => new TwilioMediaTransport(),
  plivo: () => new PlivoMediaTransport(),
  telnyx: () => new TelnyxMediaTransport(),
  vonage: () => new VonageMediaTransport(),
};

describe.each(["twilio", "plivo", "telnyx", "vonage"])("%s session fixtures", (provider) => {
  for (const c of load(`fixtures/providers/${provider}/sessions.json`).cases) {
    it(c.name, async () => {
      const connection = new RecordingConnection();
      const session = transports[provider]!().createSession(connection, { ...c.options, now: () => 1000 });
      for (const [i, step] of c.steps.entries()) {
        const sentBefore = connection.sent.length;
        const binaryBefore = connection.binary.length;
        const run = async () => {
          if ("receive" in step) session.receive(JSON.stringify(step.receive));
          else if ("receiveRaw" in step) session.receive(step.receiveRaw);
          else if ("receiveBinaryHex" in step) session.receive(new Uint8Array(Buffer.from(step.receiveBinaryHex, "hex")));
          else await runAction(session, step.action);
        };
        if (step.expectError) {
          const err = await run().then(() => undefined, (e: unknown) => e);
          expect(err, `step ${i}`).toBeInstanceOf(ProviderError);
          expect((err as ProviderError).code, `step ${i}: ${(err as Error).message}`).toBe(step.expectError);
          expect(connection.sent.length, `step ${i} wrote despite failing`).toBe(sentBefore);
          expect(connection.binary.length, `step ${i} wrote binary despite failing`).toBe(binaryBefore);
        } else {
          await run();
        }
        if (step.expectSent) expect(JSON.parse(connection.sent.at(-1)!), `step ${i}`).toEqual(step.expectSent);
        if (step.expectSentBinaryHex) expect(Buffer.from(connection.binary.at(-1)!).toString("hex"), `step ${i}`).toBe(step.expectSentBinaryHex);
      }
      await session.close();
      const events: TelephonyEvent[] = [];
      for await (const e of session.events()) events.push(e);
      const wire = events.map(eventToWire);
      for (const w of wire) expect(validEvent(w), JSON.stringify(validEvent.errors)).toBe(true);
      expect(wire).toEqual(c.expectEvents);
    });
  }
});

const mulawFormat = { encoding: "mulaw", sampleRate: 8000, channels: 1 } as const;
const targets: MediaConformanceTarget[] = [
  {
    name: "telnyx",
    createAdapter: () => new TelnyxMediaTransport(),
    inputFormat: mulawFormat,
    startMessage: ({ callId, sessionId }) =>
      JSON.stringify({ event: "start", sequence_number: "1", stream_id: sessionId, start: { call_control_id: callId, media_format: { encoding: "PCMU", sample_rate: 8000, channels: 1 } } }),
    mediaMessage: ({ sessionId }, payload, seq) =>
      JSON.stringify({ event: "media", sequence_number: String(seq), stream_id: sessionId, media: { track: "inbound", chunk: String(seq), timestamp: "0", payload } }),
    stopMessage: ({ callId, sessionId }) => JSON.stringify({ event: "stop", sequence_number: "99", stream_id: sessionId, stop: { call_control_id: callId } }),
  },
  {
    name: "twilio",
    createAdapter: () => new TwilioMediaTransport(),
    inputFormat: mulawFormat,
    startMessage: ({ callId, sessionId }) =>
      JSON.stringify({
        event: "start",
        sequenceNumber: "1",
        streamSid: sessionId,
        start: { streamSid: sessionId, callSid: callId, accountSid: "AC1", tracks: ["inbound"], mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 } },
      }),
    mediaMessage: ({ sessionId }, payload, seq) =>
      JSON.stringify({ event: "media", sequenceNumber: String(seq), streamSid: sessionId, media: { track: "inbound", chunk: String(seq), timestamp: "0", payload } }),
    stopMessage: ({ callId, sessionId }) =>
      JSON.stringify({ event: "stop", sequenceNumber: "99", streamSid: sessionId, stop: { accountSid: "AC1", callSid: callId } }),
  },
  {
    name: "plivo",
    createAdapter: () => new PlivoMediaTransport(),
    inputFormat: mulawFormat,
    startMessage: ({ callId, sessionId }) =>
      JSON.stringify({
        event: "start",
        sequenceNumber: 0,
        start: { callId, streamId: sessionId, accountId: "MA1", tracks: ["inbound"], mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000 } },
      }),
    mediaMessage: ({ sessionId }, payload, seq) =>
      JSON.stringify({ event: "media", sequenceNumber: seq, streamId: sessionId, media: { track: "inbound", timestamp: "1729670400000", chunk: seq, payload } }),
  },
];

describe.each(targets.map((t) => [t.name, t] as const))("%s conformance", (_name, target) => {
  for (const c of mediaConformanceChecks(target)) it(c.name, c.run);

  it("declares every capability explicitly at the type level too", () => {
    const caps = target.createAdapter().capabilities().capabilities;
    expect(Object.keys(caps).sort()).toEqual([...CAPABILITIES].sort());
  });
});

describe("Vonage WebSocket authorization", () => {

  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const sign = (payload: object, secret: string, alg = "HS256") => {
    const head = b64({ alg, typ: "JWT" });
    const body = b64(payload);
    return `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
  };
  const nowMs = 1_800_000_000_000;
  const req = (authorization?: string) => ({ url: "wss://example.com/socket", headers: authorization ? { Authorization: authorization } : {} });

  it("checks a custom Authorization value", async () => {
    const t = new VonageMediaTransport({ authorization: { mode: "custom", expected: async () => "Token abc" } });
    await expect(t.validateConnection(req("Token abc"))).resolves.toBeUndefined();
    await expect(t.validateConnection(req("Token abd"))).rejects.toMatchObject({ code: "authentication_failed" });
  });

  it("verifies Vonage-signed HS256 JWTs and rejects stale, tampered or wrong-algorithm tokens", async () => {
    const t = new VonageMediaTransport({ authorization: { mode: "vonage", signatureSecret: async () => "sig-secret", now: () => nowMs } });
    const iat = nowMs / 1000 - 10;
    await expect(t.validateConnection(req(`Bearer ${sign({ iat }, "sig-secret")}`))).resolves.toBeUndefined();
    for (const bad of [
      sign({ iat }, "other-secret"),
      sign({ iat: iat - 3600 }, "sig-secret"),
      sign({ iat, exp: iat }, "sig-secret"),
      sign({ iat }, "sig-secret", "none"),
      sign({}, "sig-secret"),
      "not-a-jwt",
    ]) {
      await expect(t.validateConnection(req(`Bearer ${bad}`))).rejects.toMatchObject({ code: "authentication_failed" });
    }
    await expect(t.validateConnection(req())).rejects.toMatchObject({ code: "authentication_failed" });
  });

  it("requires authorization to be configured", async () => {
    await expect(new VonageMediaTransport().validateConnection(req("x"))).rejects.toMatchObject({ code: "invalid_configuration" });
  });
});
