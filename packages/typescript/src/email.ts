// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vasik Mansuri
/**
 * Provider-independent email capture from normalized transcript events.
 * It never speaks or prompts: results tell the host agent what to say next.
 */
import { ProviderError } from "./errors.js";

/** Normalized STT output. Only `final` events are acted on; partials are ignored. */
export interface TranscriptEvent {
  readonly eventId: string;
  readonly tenantId: string;
  readonly sessionId: string;
  /** Stable id of the caller utterance; revisions of the same utterance share it. */
  readonly turnId: string;
  readonly kind: "partial" | "final";
  /** Higher revision of the same turn supersedes lower ones. */
  readonly revision: number;
  readonly text: string;
  /** 0..1 when the STT provider reports it, otherwise null. Never invented. */
  readonly confidence: number | null;
  readonly receivedAtMs: number;
}

export type ClarifyReason =
  | "incomplete_domain"
  | "ambiguous_local_part"
  | "missing_local_part"
  | "invalid_format"
  | "low_confidence";

export type EmailExtraction =
  | { readonly kind: "email"; readonly email: string; readonly literal: boolean }
  | { readonly kind: "clarify"; readonly reason: ClarifyReason; readonly heard: string }
  | null;

// ---------------------------------------------------------------------------------------------
// Extraction (pure; mirrored exactly in Python)

const LITERAL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/;
const CUE = /\b(?:e-?mail|mail|address)\b/;
const PHRASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bat the rate of\b/g, " @ "],
  [/\bat the rate\b/g, " @ "],
  [/\bat sign\b/g, " @ "],
  [/\bat symbol\b/g, " @ "],
  [/\bfull stop\b/g, " . "],
  [/\bunder score\b/g, " _ "],
  [/\b([a-z0-9]) as in [a-z]+\b/g, "$1"],
];
const WORDS: Readonly<Record<string, string>> = {
  at: "@",
  dot: ".",
  period: ".",
  point: ".",
  underscore: "_",
  hyphen: "-",
  dash: "-",
  plus: "+",
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
};
/** Words that end a spoken address on the left; anything else there makes the local part ambiguous. */
const STOP = new Set([
  "is", "it's", "its", "it", "email", "e-mail", "mail", "address", "my", "the", "to", "use", "send", "try",
  "reach", "contact", "be", "was", "id", "that's", "thats", "yes", "yeah", "sure", "ok", "okay", "so", "um",
  "uh", "and", "actually", "no", "correction", "here", "can", "you", "number", "mine", "under", "instead",
  "please", "write", "type", "i",
]);
const SEPARATORS = new Set([".", "_", "-", "+"]);
const WORD = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SINGLE = /^[a-z0-9]$/;
const STRIP = /^[,.!?;:"'()]+|[,.!?;:"'()]+$/g;

function tokenize(lower: string): string[] {
  let text = lower;
  for (const [pattern, replacement] of PHRASES) text = text.replace(pattern, replacement);
  return text
    .split(/\s+/)
    .map((t) => (t === "@" ? t : t.replace(STRIP, "")))
    .filter((t) => t.length > 0)
    .map((t) => WORDS[t] ?? t);
}

const isWord = (t: string | undefined): t is string => t !== undefined && WORD.test(t);
const isSingle = (t: string | undefined): boolean => t !== undefined && SINGLE.test(t);

function fromAt(tokens: readonly string[], at: number): Exclude<EmailExtraction, null> {
  const domain: string[] = [];
  let j = at + 1;
  if (isWord(tokens[j])) {
    domain.push(tokens[j]!);
    j++;
    while (tokens[j] === "." && isWord(tokens[j + 1])) {
      domain.push(tokens[j + 1]!);
      j += 2;
    }
  }

  const local: string[] = [];
  let k = at - 1;
  if (isWord(tokens[k]) && !STOP.has(tokens[k]!)) {
    local.unshift(tokens[k]!);
    k--;
    while (k >= 0) {
      const t = tokens[k]!;
      if (SEPARATORS.has(t) && isWord(tokens[k - 1])) {
        local.unshift(tokens[k - 1]!, t);
        k -= 2;
      } else if (isSingle(t) && isSingle(local[0])) {
        local.unshift(t);
        k--;
      } else {
        break;
      }
    }
  }

  const heard = `${local.join("")}@${domain.join(".")}`;
  if (local.length === 0) {
    const reason = SEPARATORS.has(tokens[at - 1] ?? "") ? "invalid_format" : "missing_local_part";
    return { kind: "clarify", reason, heard };
  }
  if (domain.length < 2) return { kind: "clarify", reason: "incomplete_domain", heard };
  if (!/^[a-z]{2,}$/.test(domain.at(-1)!)) return { kind: "clarify", reason: "invalid_format", heard };
  if (isWord(tokens[k]) && !STOP.has(tokens[k]!)) return { kind: "clarify", reason: "ambiguous_local_part", heard };
  return { kind: "email", email: heard, literal: false };
}

/** Finds an email address in one utterance. Never fills in missing characters. */
export function extractEmail(text: string): EmailExtraction {
  const lower = text.toLowerCase();
  const literal = LITERAL.exec(lower);
  if (literal) return { kind: "email", email: literal[0], literal: true };
  const tokens = tokenize(lower);
  let clarify: EmailExtraction = null;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== "@") continue;
    const found = fromAt(tokens, i);
    if (found.kind === "email") return found;
    clarify ??= found;
  }
  return CUE.test(lower) ? clarify : null;
}

// ---------------------------------------------------------------------------------------------
// Session state and engine

export type EmailStatus = "none" | "asked" | "declined" | "candidate" | "confirmed";

/** JSON-serializable so any store (Redis, SQL, ...) can persist it. */
export interface EmailState {
  tenantId: string;
  sessionId: string;
  status: EmailStatus;
  /** Last confirmed address. Only changed by confirm(). */
  email: string | null;
  /** Unconfirmed address awaiting the caller's confirmation. */
  candidate: string | null;
  candidateTurnId: string | null;
  declinedDeferred: boolean | null;
  turnRevisions: Record<string, number>;
  processedEventIds: string[];
}

export type EmailCaptureResult =
  | { type: "candidate"; email: string; literal: boolean; turnId: string; replacesConfirmed: boolean }
  | { type: "confirmed"; email: string }
  | { type: "clarification_needed"; reason: ClarifyReason; heard: string; turnId: string }
  | { type: "declined"; deferred: boolean; turnId: string }
  | { type: "kept_confirmed"; email: string; heard: string; turnId: string };

export interface EmailStateStore {
  get(tenantId: string, sessionId: string): Promise<EmailState | null>;
  set(state: EmailState): Promise<void>;
  delete(tenantId: string, sessionId: string): Promise<void>;
}

const key = (tenantId: string, sessionId: string) => JSON.stringify([tenantId, sessionId]);

/** Process-local store. Stores JSON copies so behaviour matches an external store. */
export class InMemoryEmailStateStore implements EmailStateStore {
  private readonly states = new Map<string, string>();

  async get(tenantId: string, sessionId: string): Promise<EmailState | null> {
    const raw = this.states.get(key(tenantId, sessionId));
    return raw === undefined ? null : (JSON.parse(raw) as EmailState);
  }

  async set(state: EmailState): Promise<void> {
    this.states.set(key(state.tenantId, state.sessionId), JSON.stringify(state));
  }

  async delete(tenantId: string, sessionId: string): Promise<void> {
    this.states.delete(key(tenantId, sessionId));
  }
}

export interface EmailCaptureOptions {
  readonly store?: EmailStateStore;
  /** Finals below this STT confidence ask for clarification instead of producing a candidate. */
  readonly minConfidence?: number;
}

const REFUSAL =
  /\b(?:skip|rather not|prefer not|don't want|do not want|no thanks|no thank you|not now|later|don't have|do not have|another time)\b/;
const DEFERRAL = /\b(?:later|not now|another time)\b/;
const CORRECTION = /\b(?:actually|correction|change it|change my email|update it|instead|that's wrong|wrong)\b/;
const MAX_EVENT_IDS = 256;
const MAX_TURNS = 64;

function initialState(tenantId: string, sessionId: string): EmailState {
  return {
    tenantId,
    sessionId,
    status: "none",
    email: null,
    candidate: null,
    candidateTurnId: null,
    declinedDeferred: null,
    turnRevisions: {},
    processedEventIds: [],
  };
}

export class EmailCapture {
  private readonly store: EmailStateStore;
  private readonly minConfidence: number;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(options: EmailCaptureOptions = {}) {
    this.store = options.store ?? new InMemoryEmailStateStore();
    this.minConfidence = options.minConfidence ?? 0.5;
  }

  async getState(tenantId: string, sessionId: string): Promise<EmailState> {
    return (await this.store.get(tenantId, sessionId)) ?? initialState(tenantId, sessionId);
  }

  /** Call when the agent asks for the email; enables refusal detection. */
  questionAsked(tenantId: string, sessionId: string): Promise<EmailCaptureResult[]> {
    return this.update(tenantId, sessionId, (state) => {
      if (state.status === "none" || state.status === "declined") state.status = "asked";
      return [];
    });
  }

  /** Call after the caller confirms the read-back candidate. */
  confirm(tenantId: string, sessionId: string): Promise<EmailCaptureResult[]> {
    return this.update(tenantId, sessionId, (state) => {
      if (state.candidate === null) return [];
      const email = state.candidate;
      Object.assign(state, { email, candidate: null, candidateTurnId: null, status: "confirmed" });
      return [{ type: "confirmed", email }];
    });
  }

  /** Call when the caller says the read-back candidate is wrong. */
  reject(tenantId: string, sessionId: string): Promise<EmailCaptureResult[]> {
    return this.update(tenantId, sessionId, (state) => {
      state.candidate = null;
      state.candidateTurnId = null;
      state.status = state.email === null ? "asked" : "confirmed";
      return [];
    });
  }

  handle(event: TranscriptEvent): Promise<EmailCaptureResult[]> {
    if (!event.eventId || !event.tenantId || !event.sessionId || !event.turnId) {
      throw new ProviderError({
        code: "malformed_message",
        provider: "email_capture",
        message: "Transcript events need eventId, tenantId, sessionId and turnId.",
      });
    }
    if (event.kind !== "final") return Promise.resolve([]);
    return this.update(event.tenantId, event.sessionId, (state) => this.apply(state, event));
  }

  private apply(state: EmailState, event: TranscriptEvent): EmailCaptureResult[] {
    if (state.processedEventIds.includes(event.eventId)) return [];
    state.processedEventIds = [...state.processedEventIds, event.eventId].slice(-MAX_EVENT_IDS);
    const previous = state.turnRevisions[event.turnId];
    if (previous !== undefined && event.revision <= previous) return [];
    delete state.turnRevisions[event.turnId];
    state.turnRevisions[event.turnId] = event.revision;
    const turns = Object.keys(state.turnRevisions);
    for (const old of turns.slice(0, Math.max(0, turns.length - MAX_TURNS))) delete state.turnRevisions[old];

    const lower = event.text.toLowerCase();
    const found = extractEmail(event.text);
    const turnId = event.turnId;
    if (found === null) {
      if (state.status !== "asked" || !REFUSAL.test(lower)) return [];
      const deferred = DEFERRAL.test(lower);
      Object.assign(state, { status: "declined", declinedDeferred: deferred });
      return [{ type: "declined", deferred, turnId }];
    }
    if (found.kind === "clarify") return [{ type: "clarification_needed", reason: found.reason, heard: found.heard, turnId }];
    if (event.confidence !== null && event.confidence < this.minConfidence) {
      return [{ type: "clarification_needed", reason: "low_confidence", heard: found.email, turnId }];
    }
    if (found.email === state.candidate || (found.email === state.email && state.candidate === null)) return [];
    const revisesCandidateTurn = state.candidateTurnId === turnId;
    if (state.email !== null && !CORRECTION.test(lower) && !revisesCandidateTurn) {
      return [{ type: "kept_confirmed", email: state.email, heard: found.email, turnId }];
    }
    Object.assign(state, { status: "candidate", candidate: found.email, candidateTurnId: turnId });
    return [{ type: "candidate", email: found.email, literal: found.literal, turnId, replacesConfirmed: state.email !== null }];
  }

  /** Serializes read-modify-write per tenant/session so concurrent events cannot interleave. */
  private update(
    tenantId: string,
    sessionId: string,
    mutate: (state: EmailState) => EmailCaptureResult[],
  ): Promise<EmailCaptureResult[]> {
    const k = key(tenantId, sessionId);
    const run = (this.locks.get(k) ?? Promise.resolve()).then(async () => {
      const state = await this.getState(tenantId, sessionId);
      const results = mutate(state);
      await this.store.set(state);
      return results;
    });
    const tail = run.catch(() => undefined);
    this.locks.set(k, tail);
    void tail.then(() => {
      if (this.locks.get(k) === tail) this.locks.delete(k);
    });
    return run;
  }
}
