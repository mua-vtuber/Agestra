import type { AIProvider } from "./types.js";
import { ProviderNotFoundError } from "./errors.js";
import type { ProviderCapabilityProfile, ProviderTier } from "./provider-capability.js";
import { buildCapabilityProfile, DEFAULT_CAPABILITIES } from "./provider-capability.js";

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
}
