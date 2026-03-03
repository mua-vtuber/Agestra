import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { AIProvider, ProviderRegistry } from "@agestra/core";
import {
  generateProvidersConfig,
  updateProvidersConfig,
  registerDetectedProviders,
  type DetectionResult,
} from "../tools/provider-detector.js";

// ── Mock helpers ─────────────────────────────────────────────

function mockRegistry(providers: AIProvider[]): ProviderRegistry {
  const map = new Map<string, AIProvider>();
  for (const p of providers) {
    map.set(p.id, p);
  }
  return {
    register: vi.fn((p: AIProvider) => map.set(p.id, p)),
    get: (id: string) => {
      const p = map.get(id);
      if (!p) throw new Error(`Provider not found: ${id}`);
      return p;
    },
    getAll: () => [...map.values()],
    getAvailable: () => [...map.values()].filter((p) => p.isAvailable()),
    getByCapability: () => [],
    has: (id: string) => map.has(id),
  } as unknown as ProviderRegistry;
}

function mockProvider(id: string, type: string, available = true): AIProvider {
  return {
    id,
    type,
    initialize: vi.fn(),
    healthCheck: async () => ({ status: "ok" as const, message: "OK" }),
    getCapabilities: () => ({
      maxContext: 4096,
      supportsSystemPrompt: true,
      supportsFiles: false,
      supportsStreaming: false,
      supportsJsonOutput: false,
      supportsToolUse: false,
      strengths: [],
      models: [],
    }),
    isAvailable: () => available,
    chat: async () => ({ text: "r", model: "m", provider: id }),
  };
}

// ── Tests ────────────────────────────────────────────────────

describe("provider-detector", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "provider-detector-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("generateProvidersConfig", () => {
    it("should create config from all-available detection results", () => {
      const results: DetectionResult[] = [
        { id: "ollama", type: "ollama", available: true },
        { id: "gemini", type: "gemini-cli", available: true },
        { id: "codex", type: "codex-cli", available: true },
      ];

      const config = generateProvidersConfig(results);

      expect(config.defaultProvider).toBe("ollama");
      expect(config.selectionPolicy).toBe("default-only");
      expect(config.providers).toHaveLength(3);

      const ollama = config.providers.find((p) => p.id === "ollama")!;
      expect(ollama.enabled).toBe(true);
      expect(ollama.type).toBe("ollama");
      expect(ollama.executionPolicy).toBe("workspace-write");
      expect(ollama.config.host).toBe("http://localhost:11434");

      const gemini = config.providers.find((p) => p.id === "gemini")!;
      expect(gemini.enabled).toBe(true);
      expect(gemini.executionPolicy).toBe("read-only");
      expect(gemini.config.timeout).toBe(120000);
    });

    it("should set defaultProvider to first available", () => {
      const results: DetectionResult[] = [
        { id: "ollama", type: "ollama", available: false },
        { id: "gemini", type: "gemini-cli", available: true },
        { id: "codex", type: "codex-cli", available: false },
      ];

      const config = generateProvidersConfig(results);
      expect(config.defaultProvider).toBe("gemini");
    });

    it("should leave defaultProvider undefined when none available", () => {
      const results: DetectionResult[] = [
        { id: "ollama", type: "ollama", available: false },
      ];

      const config = generateProvidersConfig(results);
      expect(config.defaultProvider).toBeUndefined();
    });

    it("should set enabled=false for unavailable providers", () => {
      const results: DetectionResult[] = [
        { id: "ollama", type: "ollama", available: false },
        { id: "gemini", type: "gemini-cli", available: true },
      ];

      const config = generateProvidersConfig(results);
      expect(config.providers[0].enabled).toBe(false);
      expect(config.providers[1].enabled).toBe(true);
    });
  });

  describe("updateProvidersConfig", () => {
    it("should create new file when none exists", () => {
      const results: DetectionResult[] = [
        { id: "ollama", type: "ollama", available: true },
        { id: "gemini", type: "gemini-cli", available: false },
      ];

      const result = updateProvidersConfig(tempDir, results, false);

      expect(result.action).toBe("created");
      expect(result.path).toContain("providers.config.json");

      const written = JSON.parse(readFileSync(result.path, "utf-8"));
      expect(written.defaultProvider).toBe("ollama");
      expect(written.providers).toHaveLength(2);
      expect(written.providers[0].enabled).toBe(true);
      expect(written.providers[1].enabled).toBe(false);
    });

    it("should return unchanged when existing config matches detection", () => {
      const existing = {
        defaultProvider: "ollama",
        selectionPolicy: "default-only",
        providers: [
          {
            id: "ollama",
            type: "ollama",
            enabled: true,
            executionPolicy: "workspace-write",
            config: { host: "http://custom:11434" },
          },
        ],
      };
      writeFileSync(join(tempDir, "providers.config.json"), JSON.stringify(existing));

      const results: DetectionResult[] = [
        { id: "ollama", type: "ollama", available: true },
      ];

      const result = updateProvidersConfig(tempDir, results, false);
      expect(result.action).toBe("unchanged");
    });

    it("should update enabled flag when detection differs", () => {
      const existing = {
        defaultProvider: "ollama",
        selectionPolicy: "default-only",
        providers: [
          {
            id: "ollama",
            type: "ollama",
            enabled: true,
            executionPolicy: "workspace-write",
            config: { host: "http://custom:11434" },
          },
        ],
      };
      writeFileSync(join(tempDir, "providers.config.json"), JSON.stringify(existing));

      const results: DetectionResult[] = [
        { id: "ollama", type: "ollama", available: false },
      ];

      const result = updateProvidersConfig(tempDir, results, false);
      expect(result.action).toBe("updated");

      const written = JSON.parse(readFileSync(result.path, "utf-8"));
      expect(written.providers[0].enabled).toBe(false);
      // User config preserved
      expect(written.providers[0].config.host).toBe("http://custom:11434");
    });

    it("should add newly detected providers to existing config", () => {
      const existing = {
        defaultProvider: "ollama",
        selectionPolicy: "default-only",
        providers: [
          {
            id: "ollama",
            type: "ollama",
            enabled: true,
            executionPolicy: "workspace-write",
            config: { host: "http://localhost:11434" },
          },
        ],
      };
      writeFileSync(join(tempDir, "providers.config.json"), JSON.stringify(existing));

      const results: DetectionResult[] = [
        { id: "ollama", type: "ollama", available: true },
        { id: "gemini", type: "gemini-cli", available: true },
      ];

      const result = updateProvidersConfig(tempDir, results, false);
      expect(result.action).toBe("updated");

      const written = JSON.parse(readFileSync(result.path, "utf-8"));
      expect(written.providers).toHaveLength(2);
      expect(written.providers[1].id).toBe("gemini");
      expect(written.providers[1].enabled).toBe(true);
    });

    it("should not write when dryRun is true", () => {
      const results: DetectionResult[] = [
        { id: "ollama", type: "ollama", available: true },
      ];

      const result = updateProvidersConfig(tempDir, results, true);
      expect(result.action).toBe("created");

      const configPath = join(tempDir, "providers.config.json");
      expect(() => readFileSync(configPath)).toThrow();
    });

    it("should update defaultProvider when current default becomes disabled", () => {
      const existing = {
        defaultProvider: "ollama",
        selectionPolicy: "default-only",
        providers: [
          {
            id: "ollama",
            type: "ollama",
            enabled: true,
            executionPolicy: "workspace-write",
            config: {},
          },
          {
            id: "gemini",
            type: "gemini-cli",
            enabled: true,
            executionPolicy: "read-only",
            config: {},
          },
        ],
      };
      writeFileSync(join(tempDir, "providers.config.json"), JSON.stringify(existing));

      const results: DetectionResult[] = [
        { id: "ollama", type: "ollama", available: false },
        { id: "gemini", type: "gemini-cli", available: true },
      ];

      const result = updateProvidersConfig(tempDir, results, false);
      expect(result.action).toBe("updated");

      const written = JSON.parse(readFileSync(result.path, "utf-8"));
      expect(written.defaultProvider).toBe("gemini");
    });

    it("should handle corrupted config file by overwriting", () => {
      writeFileSync(join(tempDir, "providers.config.json"), "not-json{{{");

      const results: DetectionResult[] = [
        { id: "ollama", type: "ollama", available: true },
      ];

      const result = updateProvidersConfig(tempDir, results, false);
      expect(result.action).toBe("created");

      const written = JSON.parse(readFileSync(result.path, "utf-8"));
      expect(written.providers).toHaveLength(1);
    });
  });

  describe("registerDetectedProviders", () => {
    it("should register providers not already in registry", () => {
      const registry = mockRegistry([]);
      const providers = [mockProvider("gemini", "gemini-cli")];

      registerDetectedProviders(providers, registry);

      expect(registry.has("gemini")).toBe(true);
      expect((registry.register as any)).toHaveBeenCalledTimes(1);
    });

    it("should skip providers already registered", () => {
      const existing = mockProvider("ollama", "ollama");
      const registry = mockRegistry([existing]);
      const providers = [
        mockProvider("ollama", "ollama"),
        mockProvider("gemini", "gemini-cli"),
      ];

      registerDetectedProviders(providers, registry);

      // Only gemini should be registered (ollama already exists)
      expect((registry.register as any)).toHaveBeenCalledTimes(1);
      expect((registry.register as any).mock.calls[0][0].id).toBe("gemini");
    });

    it("should handle empty providers array", () => {
      const registry = mockRegistry([]);
      registerDetectedProviders([], registry);
      expect((registry.register as any)).not.toHaveBeenCalled();
    });
  });
});
