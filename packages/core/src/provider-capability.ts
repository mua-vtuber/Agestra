import type { ProviderCapability } from "./types.js";

export type ProviderTier = "tool" | "agent";

export interface ProviderCapabilityProfile {
  providerId: string;
  tier: ProviderTier;
  strengths: string[];
  maxComplexity: "simple" | "moderate" | "complex";
}

export const DEFAULT_CAPABILITIES: Record<
  string,
  Partial<ProviderCapabilityProfile>
> = {
  ollama: { tier: "tool", maxComplexity: "simple" },
  "gemini-cli": { tier: "agent", maxComplexity: "complex" },
  "codex-cli": { tier: "agent", maxComplexity: "complex" },
};

export function buildCapabilityProfile(
  providerId: string,
  capability: ProviderCapability,
): ProviderCapabilityProfile {
  const defaults = DEFAULT_CAPABILITIES[providerId] ?? {};
  return {
    providerId,
    tier: defaults.tier ?? "tool",
    strengths: defaults.strengths ?? capability.strengths,
    maxComplexity: defaults.maxComplexity ?? "simple",
  };
}
