// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vasik Mansuri
import { ProviderError } from "./errors.js";
import { CAPABILITIES, type Capability, type ProviderCapabilities } from "./types.js";

/**
 * Throws a ProviderError unless `capability` is declared as "supported".
 * Call this before every optional operation; never silently no-op.
 */
export function requireCapability(caps: ProviderCapabilities, capability: Capability): void {
  const entry = caps.capabilities[capability];
  const note = entry?.note ? ` ${entry.note}` : "";
  if (entry === undefined) {
    throw new ProviderError({
      code: "unsupported_capability",
      provider: caps.provider,
      capability,
      message: `${capability} is not declared by the ${caps.provider} adapter, so it is treated as unsupported.`,
    });
  }
  switch (entry.support) {
    case "supported":
      return;
    case "requires_configuration":
      throw new ProviderError({
        code: "invalid_configuration",
        provider: caps.provider,
        capability,
        message: `${capability} needs additional configuration on ${caps.provider}.${note}`,
      });
    case "unsupported":
      throw new ProviderError({
        code: "unsupported_capability",
        provider: caps.provider,
        capability,
        message: `${capability} is not implemented by the ${caps.provider} adapter.${note}`,
      });
    case "unavailable_from_provider":
      throw new ProviderError({
        code: "unsupported_capability",
        provider: caps.provider,
        capability,
        message: `${capability} is not offered by ${caps.provider}.${note}`,
      });
  }
}

export function supports(caps: ProviderCapabilities, capability: Capability): boolean {
  return caps.capabilities[capability]?.support === "supported";
}

/** Conformance rule: built-in adapters must declare every capability explicitly. */
export function undeclaredCapabilities(caps: ProviderCapabilities): Capability[] {
  return CAPABILITIES.filter((c) => caps.capabilities[c] === undefined);
}
