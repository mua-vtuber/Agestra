import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { AIProvider, ProviderRegistry } from "@agestra/core";
import { atomicWriteJsonSync, DEFAULT_OLLAMA_HOST } from "@agestra/core";
import { OllamaProvider } from "@agestra/provider-ollama";
import { GeminiProvider } from "@agestra/provider-gemini";
import { CodexProvider } from "@agestra/provider-codex";

// ── Types ────────────────────────────────────────────────────

export interface DetectionResult {
  id: string;
  type: string;
  available: boolean;
}

interface ProviderConfigEntry {
  id: string;
  type: string;
  enabled: boolean;
  executionPolicy: string;
  config: Record<string, unknown>;
}

export interface ProvidersConfigJson {
  defaultProvider?: string;
  selectionPolicy: string;
  providers: ProviderConfigEntry[];
}

// ── Default configs per provider type ────────────────────────

const DEFAULT_CONFIGS: Record<string, { executionPolicy: string; config: Record<string, unknown> }> = {
  ollama: {
    executionPolicy: "workspace-write",
    config: { host: DEFAULT_OLLAMA_HOST, defaultModel: "auto" },
  },
  "gemini-cli": {
    executionPolicy: "read-only",
    config: { timeout: 120000 },
  },
  "codex-cli": {
    executionPolicy: "read-only",
    config: { timeout: 120000 },
  },
};

// ── Detection ────────────────────────────────────────────────

/**
 * Detect installed providers by instantiating and initializing each known type.
 * Returns detection results and the initialized provider instances.
 */
export async function detectProviders(): Promise<{
  results: DetectionResult[];
  providers: AIProvider[];
}> {
  const candidates: Array<{ id: string; type: string; provider: AIProvider }> = [
    {
      id: "ollama",
      type: "ollama",
      provider: new OllamaProvider({ id: "ollama", host: DEFAULT_OLLAMA_HOST }),
    },
    {
      id: "gemini",
      type: "gemini-cli",
      provider: new GeminiProvider({ id: "gemini" }),
    },
    {
      id: "codex",
      type: "codex-cli",
      provider: new CodexProvider({ id: "codex" }),
    },
  ];

  const results: DetectionResult[] = [];
  const providers: AIProvider[] = [];

  await Promise.all(
    candidates.map(async (c) => {
      try {
        await c.provider.initialize();
      } catch {
        // initialize failed — provider not available
      }
      const available = c.provider.isAvailable();
      results.push({ id: c.id, type: c.type, available });
      if (available) {
        providers.push(c.provider);
      }
    }),
  );

  // Sort to maintain stable order: ollama, gemini, codex
  const order = ["ollama", "gemini", "codex"];
  results.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  providers.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

  return { results, providers };
}

// ── Config Generation ────────────────────────────────────────

/**
 * Generate a providers.config.json structure from detection results.
 */
export function generateProvidersConfig(results: DetectionResult[]): ProvidersConfigJson {
  const firstAvailable = results.find((r) => r.available);

  return {
    defaultProvider: firstAvailable?.id,
    selectionPolicy: "default-only",
    providers: results.map((r) => {
      const defaults = DEFAULT_CONFIGS[r.type] || {
        executionPolicy: "read-only",
        config: {},
      };
      return {
        id: r.id,
        type: r.type,
        enabled: r.available,
        executionPolicy: defaults.executionPolicy,
        config: { ...defaults.config },
      };
    }),
  };
}

// ── Config File Update ───────────────────────────────────────

/**
 * Create or update providers.config.json.
 *
 * - File absent → create from detection results
 * - File present → merge: update `enabled` flags, preserve user settings (host, timeout, etc.),
 *   add newly detected providers
 */
export function updateProvidersConfig(
  outputDir: string,
  results: DetectionResult[],
  dryRun: boolean,
): { action: "created" | "updated" | "unchanged"; path: string } {
  const configPath = join(outputDir, "providers.config.json");

  if (!existsSync(configPath)) {
    const config = generateProvidersConfig(results);
    if (!dryRun) {
      atomicWriteJsonSync(configPath, config);
    }
    return { action: "created", path: configPath };
  }

  // Merge with existing
  let existing: ProvidersConfigJson;
  try {
    existing = JSON.parse(readFileSync(configPath, "utf-8")) as ProvidersConfigJson;
  } catch {
    // Corrupted file — overwrite
    const config = generateProvidersConfig(results);
    if (!dryRun) {
      atomicWriteJsonSync(configPath, config);
    }
    return { action: "created", path: configPath };
  }

  const detectionMap = new Map(results.map((r) => [r.id, r]));
  let changed = false;

  // Update enabled flags for existing providers
  for (const p of existing.providers) {
    const detection = detectionMap.get(p.id);
    if (detection && p.enabled !== detection.available) {
      p.enabled = detection.available;
      changed = true;
    }
    detectionMap.delete(p.id);
  }

  // Add newly detected providers not in existing config
  for (const [, detection] of detectionMap) {
    const defaults = DEFAULT_CONFIGS[detection.type] || {
      executionPolicy: "read-only",
      config: {},
    };
    existing.providers.push({
      id: detection.id,
      type: detection.type,
      enabled: detection.available,
      executionPolicy: defaults.executionPolicy,
      config: { ...defaults.config },
    });
    changed = true;
  }

  // Update defaultProvider if current default is disabled
  if (existing.defaultProvider) {
    const defaultEntry = existing.providers.find((p) => p.id === existing.defaultProvider);
    if (defaultEntry && !defaultEntry.enabled) {
      const firstEnabled = existing.providers.find((p) => p.enabled);
      existing.defaultProvider = firstEnabled?.id;
      changed = true;
    }
  }

  if (!changed) {
    return { action: "unchanged", path: configPath };
  }

  if (!dryRun) {
    atomicWriteJsonSync(configPath, existing);
  }
  return { action: "updated", path: configPath };
}

// ── Registry Update ──────────────────────────────────────────

/**
 * Register detected (already-initialized) providers into the registry,
 * skipping any that are already registered.
 */
export function registerDetectedProviders(
  providers: AIProvider[],
  registry: ProviderRegistry,
): void {
  for (const provider of providers) {
    if (!registry.has(provider.id)) {
      registry.register(provider);
    }
  }
}
