import type { AIProvider } from "./types.js";
import { ProviderNotFoundError } from "./errors.js";
import type { ProviderCapabilityProfile, ProviderTier } from "./provider-capability.js";
import { buildCapabilityProfile, DEFAULT_CAPABILITIES } from "./provider-capability.js";
import type { QualityStats } from "./trace.js";

/**
 * Minimal interface for quality stats lookup.
 * Compatible with TraceWriter but avoids importing the concrete class
 * (which has filesystem side-effects on construction).
 */
export interface QualityStatsProvider {
  getQualityStats(daysBack: number): Map<string, QualityStats>;
}

export class ProviderRegistry {
  private providers = new Map<string, AIProvider>();

  register(provider: AIProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): AIProvider {
    const p = this.providers.get(id);
    if (!p) throw new ProviderNotFoundError(id);
    return p;
  }

  getAll(): AIProvider[] {
    return [...this.providers.values()];
  }

  getAvailable(): AIProvider[] {
    return this.getAll().filter((p) => p.isAvailable());
  }

  getByCapability(strength: string): AIProvider[] {
    return this.getAvailable().filter((p) =>
      p.getCapabilities().strengths.includes(strength),
    );
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  getCapability(providerId: string): ProviderCapabilityProfile {
    const provider = this.get(providerId);
    return buildCapabilityProfile(providerId, provider.getCapabilities());
  }

  getByTier(tier: ProviderTier): AIProvider[] {
    return this.getAvailable().filter((p) => {
      const defaults = DEFAULT_CAPABILITIES[p.id];
      return defaults?.tier === tier;
    });
  }

  /**
   * Select the best available provider for a given task based on
   * historical quality scores from trace data.
   *
   * Returns the provider with the highest average quality score for the
   * specified task. Falls back to the first available provider when no
   * quality data exists or no traceWriter is provided. Returns undefined
   * when no providers are available.
   */
  getBestForTask(
    task: string,
    traceWriter?: QualityStatsProvider,
  ): AIProvider | undefined {
    const available = this.getAvailable();
    if (available.length === 0) return undefined;
    if (!traceWriter) return available[0];

    const stats = traceWriter.getQualityStats(30);
    let bestProvider: AIProvider | undefined;
    let bestScore = -1;

    for (const provider of available) {
      const key = `${provider.id}:${task}`;
      const stat = stats.get(key);
      if (stat && stat.avgScore > bestScore) {
        bestScore = stat.avgScore;
        bestProvider = provider;
      }
    }

    return bestProvider ?? available[0];
  }
}
