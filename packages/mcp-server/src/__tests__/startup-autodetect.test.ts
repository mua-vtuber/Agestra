import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { autoDetectIfNeeded } from "../index.js";
import type { ProviderRegistry } from "@agestra/core";
import type { AIProvider, HealthStatus, ProviderCapability } from "@agestra/core";

// ── Mock modules ─────────────────────────────────────────────

const mockDetectProviders = vi.fn();
const mockUpdateProvidersConfig = vi.fn().mockReturnValue({ action: "created", path: "providers.config.json" });
const mockRegisterDetectedProviders = vi.fn();

vi.mock("../tools/provider-detector.js", () => ({
  detectProviders: (...args: unknown[]) => mockDetectProviders(...args),
  updateProvidersConfig: (...args: unknown[]) => mockUpdateProvidersConfig(...args),
  registerDetectedProviders: (...args: unknown[]) => mockRegisterDetectedProviders(...args),
}));

const mockGenerateClaudeMdSection = vi.fn().mockReturnValue("## Agestra section");
const mockGenerateHooksConfig = vi.fn().mockReturnValue({ SessionStart: [] });
const mockUpdateClaudeMd = vi.fn().mockReturnValue({ action: "created", path: "CLAUDE.md" });
const mockUpdateHooks = vi.fn().mockReturnValue({ action: "created", path: "settings.local.json" });

vi.mock("../tools/config-generator.js", () => ({
  generateClaudeMdSection: (...args: unknown[]) => mockGenerateClaudeMdSection(...args),
  generateHooksConfig: (...args: unknown[]) => mockGenerateHooksConfig(...args),
  updateClaudeMd: (...args: unknown[]) => mockUpdateClaudeMd(...args),
  updateHooks: (...args: unknown[]) => mockUpdateHooks(...args),
}));

// ── Helpers ──────────────────────────────────────────────────

function mockProvider(id: string): AIProvider {
  return {
    id,
    type: "mock",
    initialize: async () => {},
    healthCheck: async (): Promise<HealthStatus> => ({ status: "ok" }),
    getCapabilities: (): ProviderCapability => ({
      maxContext: 4096,
      supportsSystemPrompt: true,
      supportsFiles: false,
      supportsStreaming: false,
      supportsJsonOutput: false,
      supportsToolUse: false,
      strengths: [],
      models: [],
    }),
    isAvailable: () => true,
    chat: async () => ({ text: "mock", model: "mock", provider: id }),
  };
}

function createMockRegistry(providers: AIProvider[] = []): ProviderRegistry {
  const map = new Map<string, AIProvider>();
  for (const p of providers) map.set(p.id, p);
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

// ── Tests ────────────────────────────────────────────────────

describe("autoDetectIfNeeded", () => {
  const log = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should skip when registry already has providers", async () => {
    const registry = createMockRegistry([mockProvider("existing")]);

    const result = await autoDetectIfNeeded(registry, "/tmp/test", log);

    expect(result.detected).toBe(0);
    expect(mockDetectProviders).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("skipping auto-detect"));
  });

  it("should run auto-detect when registry is empty", async () => {
    const registry = createMockRegistry();
    const detected = [mockProvider("ollama")];
    mockDetectProviders.mockResolvedValue({
      results: [{ id: "ollama", type: "ollama", available: true }],
      providers: detected,
    });

    const result = await autoDetectIfNeeded(registry, "/tmp/test", log);

    expect(result.detected).toBe(1);
    expect(mockDetectProviders).toHaveBeenCalled();
    expect(mockUpdateProvidersConfig).toHaveBeenCalledWith("/tmp/test", expect.any(Array), false);
    expect(mockRegisterDetectedProviders).toHaveBeenCalledWith(detected, registry);
    expect(mockGenerateClaudeMdSection).toHaveBeenCalledWith(registry);
    expect(mockUpdateClaudeMd).toHaveBeenCalled();
    expect(mockGenerateHooksConfig).toHaveBeenCalled();
    expect(mockUpdateHooks).toHaveBeenCalled();
  });

  it("should return 0 when no providers are available", async () => {
    const registry = createMockRegistry();
    mockDetectProviders.mockResolvedValue({
      results: [{ id: "ollama", type: "ollama", available: false }],
      providers: [],
    });

    const result = await autoDetectIfNeeded(registry, "/tmp/test", log);

    expect(result.detected).toBe(0);
    expect(mockUpdateProvidersConfig).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no available providers"));
  });

  it("should handle detection errors gracefully", async () => {
    const registry = createMockRegistry();
    mockDetectProviders.mockRejectedValue(new Error("network failure"));

    const result = await autoDetectIfNeeded(registry, "/tmp/test", log);

    expect(result.detected).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("non-fatal"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("network failure"));
  });

  it("should generate config files on successful detection", async () => {
    const registry = createMockRegistry();
    mockDetectProviders.mockResolvedValue({
      results: [
        { id: "ollama", type: "ollama", available: true },
        { id: "gemini", type: "gemini-cli", available: true },
      ],
      providers: [mockProvider("ollama"), mockProvider("gemini")],
    });

    const result = await autoDetectIfNeeded(registry, "/my/project", log);

    expect(result.detected).toBe(2);
    expect(mockUpdateProvidersConfig).toHaveBeenCalledWith("/my/project", expect.any(Array), false);
    expect(mockUpdateClaudeMd).toHaveBeenCalledWith("/my/project", expect.any(String), false);
    expect(mockUpdateHooks).toHaveBeenCalledWith("/my/project", expect.any(Object), false);
  });
});
