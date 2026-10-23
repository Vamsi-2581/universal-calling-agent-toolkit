import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EmailCapture, InMemoryEmailStateStore, extractEmail, type TranscriptEvent } from "../src/index.js";

const contracts = fileURLToPath(new URL("../../../contracts/", import.meta.url));
const load = (path: string): any => JSON.parse(readFileSync(contracts + path, "utf8"));

describe("extractEmail", () => {
  for (const c of load("fixtures/email/extraction.json").cases) {
    it(JSON.stringify(c.text), () => expect(extractEmail(c.text)).toEqual(c.expect));
  }
});

describe("EmailCapture sessions", () => {
  for (const c of load("fixtures/email/sessions.json").cases) {
    it(c.name, async () => {
      const store = new InMemoryEmailStateStore();
      const engines: Record<string, EmailCapture> = { A: new EmailCapture({ store }), B: new EmailCapture({ store }) };
      for (const [i, step] of c.steps.entries()) {
        const engine = engines[step.engine ?? "A"]!;
        let tenantId: string = step.tenantId ?? "t1";
        let sessionId: string = step.sessionId ?? "s1";
        let results;
        if (step.event) {
          const event: TranscriptEvent = {
            tenantId,
            sessionId,
            kind: "final",
            revision: 0,
            confidence: null,
            receivedAtMs: 0,
            ...step.event,
          };
          ({ tenantId, sessionId } = event);
          results = await engine.handle(event);
        } else {
          results = await (engine as any)[step.action](tenantId, sessionId);
        }
        expect(results, `step ${i}`).toEqual(step.expect);
        if (step.expectState) {
          const { status, email, candidate } = await engine.getState(tenantId, sessionId);
          expect({ status, email, candidate }, `step ${i} state`).toEqual(step.expectState);
        }
      }
    });
  }
});

describe("EmailCapture concurrency", () => {
  it("serializes concurrent events for one session", async () => {
    const capture = new EmailCapture();
    const base = { tenantId: "t", sessionId: "s", kind: "final", revision: 0, confidence: null, receivedAtMs: 0 } as const;
    const results = await Promise.all(
      ["a", "b", "c"].map((name, i) =>
        capture.handle({ ...base, eventId: `e${i}`, turnId: `u${i}`, text: `my email is ${name} at x dot com` }),
      ),
    );
    expect(results.flat().map((r) => r.type)).toEqual(["candidate", "candidate", "candidate"]);
    expect((await capture.getState("t", "s")).candidate).toBe("c@x.com");
  });

  it("rejects events without identifiers", () => {
    expect(() =>
      new EmailCapture().handle({ eventId: "", tenantId: "t", sessionId: "s", turnId: "u", kind: "final", revision: 0, text: "", confidence: null, receivedAtMs: 0 }),
    ).toThrow(/eventId/);
  });
});
