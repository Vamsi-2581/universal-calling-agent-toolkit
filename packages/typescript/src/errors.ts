// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vasik Mansuri
import type { Capability } from "./types.js";

export const PROVIDER_ERROR_CODES = [
  "unsupported_capability",
  "invalid_configuration",
  "authentication_failed",
  "signature_invalid",
  "malformed_message",
  "protocol_violation",
  "unsupported_format",
  "buffer_overflow",
  "session_closed",
  "provider_unavailable",
  "rate_limited",
  "timeout",
  "unknown",
] as const;
export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

/** Serializable form, matching ProviderError in core.schema.json. */
export interface ProviderErrorData {
  readonly code: ProviderErrorCode;
  readonly message: string;
  readonly provider: string;
  readonly retryable: boolean;
  readonly capability?: Capability;
  readonly providerCode?: string;
  readonly callId?: string;
  readonly sessionId?: string;
}

export type ProviderErrorInit = Omit<ProviderErrorData, "retryable"> & {
  readonly retryable?: boolean;
  readonly cause?: unknown;
};

const RETRYABLE_BY_DEFAULT: ReadonlySet<ProviderErrorCode> = new Set([
  "provider_unavailable",
  "rate_limited",
  "timeout",
]);

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly provider: string;
  readonly retryable: boolean;
  readonly capability: Capability | undefined;
  readonly providerCode: string | undefined;
  readonly callId: string | undefined;
  readonly sessionId: string | undefined;

  constructor(init: ProviderErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "ProviderError";
    this.code = init.code;
    this.provider = init.provider;
    this.retryable = init.retryable ?? RETRYABLE_BY_DEFAULT.has(init.code);
    this.capability = init.capability;
    this.providerCode = init.providerCode;
    this.callId = init.callId;
    this.sessionId = init.sessionId;
  }

  toJSON(): ProviderErrorData {
    return {
      code: this.code,
      message: this.message,
      provider: this.provider,
      retryable: this.retryable,
      ...(this.capability !== undefined && { capability: this.capability }),
      ...(this.providerCode !== undefined && { providerCode: this.providerCode }),
      ...(this.callId !== undefined && { callId: this.callId }),
      ...(this.sessionId !== undefined && { sessionId: this.sessionId }),
    };
  }
}

export function isProviderError(value: unknown): value is ProviderError {
  return value instanceof ProviderError;
}
