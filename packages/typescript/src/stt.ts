// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vasik Mansuri
/**
 * Provider-neutral speech-to-text contracts, plus the reconciler that turns provider results into
 * ordered, de-duplicated TranscriptEvents (the input of EmailCapture and the RAG coordinator).
 */
import type { AudioPipeline } from "./audio-pipeline.js";
import type { TranscriptEvent } from "./email.js";
import { ProviderError } from "./errors.js";
import type { AudioFormat, AudioFrame } from "./types.js";

/** What an STT adapter reports, already normalized. Confidence is null when the provider gives none. */
export type SttResult =
  | { readonly type: "interim"; readonly text: string; readonly confidence: number | null }
  | {
      readonly type: "segment_final";
      readonly text: string;
      readonly confidence: number | null;
      /** Provider-stable id for de-duplication (e.g. start:duration). */
      readonly segmentKey: string;
      readonly startMs: number | null;
    }
  | { readonly type: "turn_end" };

export interface SttCapabilities {
  readonly provider: string;
  readonly interimResults: boolean;
  readonly wordTimestamps: boolean;
  readonly confidence: boolean;
  readonly diarization: boolean;
  readonly inputFormats: readonly AudioFormat[];
}

export interface StreamingSttSession {
  /** Sends one frame. Frames must be in the format the session was opened with. */
  sendAudio(frame: AudioFrame): Promise<void>;
  /** Tells the provider no more audio is coming; remaining results still arrive. */
  finish(): Promise<void>;
  results(): AsyncIterable<SttResult>;
  close(): Promise<void>;
}

export interface StreamingSttAdapter {
  readonly provider: string;
  capabilities(): SttCapabilities;
  open(options: { readonly format: AudioFormat; readonly language?: string; readonly signal?: AbortSignal }): Promise<StreamingSttSession>;
}

export interface BatchSttAdapter {
  readonly provider: string;
  capabilities(): SttCapabilities;
  transcribe(audio: Uint8Array, format: AudioFormat, options?: { readonly language?: string; readonly signal?: AbortSignal }): Promise<SttResult[]>;
}

export interface TranscriptReconcilerOptions {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly now?: () => number;
}

interface Segment {
  readonly text: string;
  readonly confidence: number | null;
  readonly startMs: number | null;
  readonly order: number;
}

/**
 * Builds utterances from segment finals, shows interim text on top as partials, and emits exactly one
 * final per turn. Interim text is never committed; duplicate segments are ignored.
 */
export class TranscriptReconciler {
  private turn = 1;
  private revision = 0;
  private seq = 0;
  private segments = new Map<string, Segment>();
  private readonly now: () => number;

  constructor(private readonly options: TranscriptReconcilerOptions) {
    this.now = options.now ?? Date.now;
  }

  get turnId(): string {
    return `turn-${this.turn}`;
  }

  accept(result: SttResult): TranscriptEvent[] {
    switch (result.type) {
      case "interim": {
        const text = result.text.trim();
        if (text.length === 0) return [];
        return [this.partial([...this.committed(), text].join(" "))];
      }
      case "segment_final": {
        if (this.segments.has(result.segmentKey)) return [];
        const text = result.text.trim();
        this.segments.set(result.segmentKey, {
          text,
          confidence: result.confidence,
          startMs: result.startMs,
          order: this.segments.size,
        });
        return text.length === 0 ? [] : [this.partial(this.committed().join(" "))];
      }
      case "turn_end": {
        const text = this.committed().join(" ");
        const spoken = [...this.segments.values()].filter((s) => s.text.length > 0);
        const out: TranscriptEvent[] = [];
        if (text.length > 0) {
          const confidences = spoken.map((s) => s.confidence);
          const confidence = confidences.every((c) => c !== null) ? Math.min(...(confidences as number[])) : null;
          out.push(this.event("final", 0, text, confidence));
          this.turn++;
        }
        this.segments = new Map();
        this.revision = 0;
        return out;
      }
    }
  }

  private committed(): string[] {
    const segs = [...this.segments.values()].filter((s) => s.text.length > 0);
    const timed = segs.every((s) => s.startMs !== null);
    segs.sort((a, b) => (timed && a.startMs !== b.startMs ? a.startMs! - b.startMs! : a.order - b.order));
    return segs.map((s) => s.text);
  }

  private partial(text: string): TranscriptEvent {
    return this.event("partial", this.revision++, text, null);
  }

  private event(kind: "partial" | "final", revision: number, text: string, confidence: number | null): TranscriptEvent {
    return {
      eventId: `${this.options.sessionId}:${this.turnId}:${++this.seq}`,
      tenantId: this.options.tenantId,
      sessionId: this.options.sessionId,
      turnId: this.turnId,
      kind,
      revision,
      text,
      confidence,
      receivedAtMs: this.now(),
    };
  }
}

/**
 * Connects the audio pipeline to an STT session so the STT provider receives exactly the processed
 * frames. Rejects a format mismatch instead of silently transcoding again.
 */
export class SttAudioBridge {
  constructor(
    private readonly pipeline: AudioPipeline,
    private readonly session: StreamingSttSession,
    private readonly sttFormat: AudioFormat,
  ) {
    const out = pipeline.targetFormat;
    if (out.encoding !== sttFormat.encoding || out.sampleRate !== sttFormat.sampleRate || out.channels !== sttFormat.channels) {
      throw new ProviderError({
        code: "invalid_configuration",
        provider: "stt",
        message: `Pipeline produces ${out.encoding}/${out.sampleRate}; the STT session expects ${sttFormat.encoding}/${sttFormat.sampleRate}.`,
      });
    }
  }

  async push(frame: AudioFrame): Promise<number> {
    const frames = this.pipeline.push(frame);
    for (const f of frames) await this.session.sendAudio(f);
    return frames.length;
  }

  async end(): Promise<void> {
    for (const f of this.pipeline.flush()) await this.session.sendAudio(f);
    await this.session.finish();
  }
}
