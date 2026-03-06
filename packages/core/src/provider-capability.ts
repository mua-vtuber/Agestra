import type { ProviderCapability } from "./types.js";

export type ProviderTier = "tool" | "agent";
export type OllamaComplexity = "simple" | "moderate" | "complex" | "advanced";

export interface ProviderCapabilityProfile {
  providerId: string;
  tier: ProviderTier;
  strengths: string[];
  maxComplexity: "simple" | "moderate" | "complex" | "advanced";
}

export const DEFAULT_CAPABILITIES: Record<
  string,
  Partial<ProviderCapabilityProfile>
> = {
  ollama: { tier: "tool" },
  "gemini-cli": { tier: "agent", maxComplexity: "complex" },
  "codex-cli": { tier: "agent", maxComplexity: "complex" },
};

/**
 * Classify Ollama model complexity by size in GB.
 *
 * < 3 GB  → simple   (formatting, pattern matching)
 * 3-8 GB  → moderate (code review, summarization)
 * 8-20 GB → complex  (code generation, detailed analysis)
 * > 20 GB → advanced (architecture, complex refactoring)
 */
export function classifyOllamaComplexity(sizeGb: number): OllamaComplexity {
  if (sizeGb < 3) return "simple";
  if (sizeGb < 8) return "moderate";
  if (sizeGb <= 20) return "complex";
  return "advanced";
}

export function buildCapabilityProfile(
  providerId: string,
  capability: ProviderCapability,
  ollamaModelSizeGb?: number,
): ProviderCapabilityProfile {
  const defaults = DEFAULT_CAPABILITIES[providerId] ?? {};

  let maxComplexity = defaults.maxComplexity ?? "simple";
  if (providerId === "ollama" && ollamaModelSizeGb !== undefined) {
    maxComplexity = classifyOllamaComplexity(ollamaModelSizeGb);
  }

  return {
    providerId,
    tier: defaults.tier ?? "tool",
    strengths: defaults.strengths ?? capability.strengths,
    maxComplexity,
  };
}
