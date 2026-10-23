import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ProviderError, basicAuth, callApi, type HttpRequest } from "../src/index.js";
import { PlivoCallControl } from "../src/providers/plivo.js";
import { TwilioCallControl } from "../src/providers/twilio.js";

const contracts = fileURLToPath(new URL("../../../contracts/", import.meta.url));
const load = (path: string): any => JSON.parse(readFileSync(contracts + path, "utf8"));

function makeAdapter(provider: string, config: any, http: (r: HttpRequest) => Promise<any>) {
  const authToken = async () => config.authToken as string;
  return provider === "twilio"
    ? new TwilioCallControl({ accountSid: config.accountSid, authToken, http, now: () => 1000 })
    : new PlivoCallControl({ authId: config.authId, authToken, http, now: () => 1000 });
}

function run(adapter: any, op: string, args: any) {
  switch (op) {
    case "startOutboundCall":
      return adapter.startOutboundCall({ to: args.to, from: args.from, answer: args.answer });
    case "endCall":
      return adapter.endCall(args.callId);
    case "transferCall":
      return adapter.transferCall(args.callId, args.target);
    case "sendDtmf":
      return adapter.sendDtmf(args.callId, args.digits);
    case "startMediaStream":
      return adapter.startMediaStream(args.callId, args.request);
    case "stopMediaStream":
      return adapter.stopMediaStream(args.callId, args.streamId);
    case "parseWebhook":
      return adapter.parseWebhook({ method: "POST", url: "https://example.com/cb", headers: {}, rawBody: args.rawBody });
  }
  throw new Error(`unknown op ${op}`);
}

describe.each(["twilio", "plivo"])("%s REST call control", (provider) => {
  const fixture = load(`fixtures/providers/${provider}/rest.json`);
  const user = fixture.config.accountSid ?? fixture.config.authId;
  for (const c of fixture.cases) {
    it(c.name, async () => {
      const sent: HttpRequest[] = [];
      const adapter = makeAdapter(provider, fixture.config, async (req) => {
        sent.push(req);
        return c.response;
      });
      const outcome = await Promise.resolve()
        .then(() => run(adapter, c.op, c.args))
        .then((value) => ({ value }), (error) => ({ error }));
      if (c.expectRequest === null) {
        expect(sent).toHaveLength(0);
      } else {
        expect(sent).toHaveLength(1);
        const req = sent[0]!;
        expect(req.method).toBe(c.expectRequest.method);
        expect(req.url).toBe(c.expectRequest.url);
        expect(req.headers["Authorization"]).toBe(basicAuth(user, fixture.config.authToken));
        expect(req.headers["Content-Type"]).toBe(c.expectRequest.contentType ?? undefined);
        if (c.expectRequest.body === null) expect(req.body).toBeUndefined();
        else if (typeof c.expectRequest.body === "string") expect(req.body).toBe(c.expectRequest.body);
        else expect(JSON.parse(req.body!)).toEqual(c.expectRequest.body);
      }
      if (c.expectError) {
        expect("error" in outcome, JSON.stringify(outcome)).toBe(true);
        const err = (outcome as any).error;
        expect(err).toBeInstanceOf(ProviderError);
        expect(err.code, err.message).toBe(c.expectError);
        if (c.expectProviderCode) expect(err.providerCode).toBe(c.expectProviderCode);
        if (c.expectRetryable !== undefined) expect(err.retryable).toBe(c.expectRetryable);
      } else {
        expect("value" in outcome, String((outcome as any).error)).toBe(true);
        expect((outcome as any).value ?? null).toEqual(c.expect);
      }
    });
  }
});

describe("callApi", () => {
  it("times out slow providers", async () => {
    const slow = (req: HttpRequest) =>
      new Promise<never>((_, reject) => req.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    await expect(callApi("p", slow, { method: "GET", url: "https://x", headers: {} }, { timeoutMs: 5 })).rejects.toMatchObject({
      code: "timeout",
      retryable: true,
    });
  });

  it("maps network failures to provider_unavailable", async () => {
    const down = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(callApi("p", down, { method: "GET", url: "https://x", headers: {} })).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("never sends the auth token anywhere but the Authorization header", async () => {
    const sent: HttpRequest[] = [];
    const adapter = new TwilioCallControl({
      accountSid: "AC1",
      authToken: async () => "super-secret-token",
      http: async (r) => {
        sent.push(r);
        return { status: 200, body: "{}" };
      },
    });
    await adapter.endCall("CA1");
    const { Authorization, ...rest } = sent[0]!.headers;
    expect(JSON.stringify({ ...sent[0], headers: rest })).not.toContain("super-secret-token");
    expect(Authorization).toBe(basicAuth("AC1", "super-secret-token"));
  });
});
