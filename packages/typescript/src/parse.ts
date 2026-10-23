import { ProviderError } from "./errors.js";

export type JsonObject = Record<string, unknown>;

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const DIGITS = /^\d+$/;
export const DTMF_DIGIT = /^[0-9*#A-Da-d]$/;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Case-insensitive header lookup; Node lowercases names, other frameworks may not. */
export function getHeader(headers: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === wanted) return value;
  return undefined;
}

/** Typed field access for provider JSON. Every failure is a malformed_message naming the field. */
export class MessageReader {
  constructor(readonly provider: string) {}

  fail(message: string): ProviderError {
    return new ProviderError({ code: "malformed_message", provider: this.provider, message });
  }

  json(message: string | Uint8Array, eventField = "event"): JsonObject {
    let text: string;
    if (typeof message === "string") {
      text = message;
    } else {
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(message);
      } catch {
        throw this.fail("Message is not valid UTF-8.");
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw this.fail("Message is not valid JSON.");
    }
    if (!isObject(parsed)) throw this.fail("Message is not a JSON object.");
    if (typeof parsed[eventField] !== "string") throw this.fail(`Message has no string "${eventField}" field.`);
    return parsed;
  }

  object(o: JsonObject, key: string, path = key): JsonObject {
    const value = o[key];
    if (!isObject(value)) throw this.fail(`${path} must be an object.`);
    return value;
  }

  string(o: JsonObject, key: string, path = key): string {
    const value = o[key];
    if (typeof value !== "string") throw this.fail(`${path} must be a string.`);
    return value;
  }

  id(o: JsonObject, key: string, path = key): string {
    const value = this.string(o, key, path);
    if (value.length === 0) throw this.fail(`${path} must not be empty.`);
    return value;
  }

  optionalString(o: JsonObject, key: string, path = key): string | undefined {
    return o[key] === undefined || o[key] === null ? undefined : this.string(o, key, path);
  }

  /** Non-negative integer, given as a JSON number or a decimal string (Twilio sends strings). */
  int(o: JsonObject, key: string, path = key): number {
    const value = o[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
    if (typeof value === "string" && DIGITS.test(value)) {
      const n = Number(value);
      if (Number.isSafeInteger(n)) return n;
    }
    throw this.fail(`${path} must be a non-negative integer.`);
  }

  optionalInt(o: JsonObject, key: string, path = key): number | null {
    return o[key] === undefined || o[key] === null ? null : this.int(o, key, path);
  }

  stringArray(o: JsonObject, key: string, path = key): string[] {
    const value = o[key];
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      throw this.fail(`${path} must be an array of strings.`);
    }
    return value as string[];
  }

  base64(o: JsonObject, key: string, path = key): Uint8Array {
    const value = this.string(o, key, path);
    if (!BASE64.test(value)) throw this.fail(`${path} is not valid base64.`);
    return new Uint8Array(Buffer.from(value, "base64"));
  }
}
