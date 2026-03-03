import { describe, it, expect } from "vitest";
import { ProviderRegistry } from "../registry.js";
import { parseProviderConfig } from "../config-loader.js";
import type {
  AIProvider,
  HealthStatus,
  ProviderCapability,
  ChatRequest,
  ChatResponse,
} from "../types.js";

function createStubProvider(
  id: string,
  type: string,
  available = true,
): AIProvider {
  return {
    id,
    type,
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
    isAvailable: () => available,
    chat: async (req: ChatRequest): Promise<ChatResponse> => ({
      text: "stub",
      model: "stub",
      provider: id,
    }),
  };
}

describe("Registry + Config integration", () => {
  it("should load config and register mock providers", () => {
    const raw = {
      defaultProvider: "ollama",
      providers: [
        { id: "ollama", type: "ollama", enabled: true, config: {} },
        { id: "gemini", type: "gemini-cli", enabled: true, config: {} },
        { id: "codex", type: "codex-cli", enabled: false, config: {} },
      ],
    };
    const config = parseProviderConfig(raw);
    const registry = new ProviderRegistry();

    // Only register enabled providers
    for (const pc of config.enabledProviders) {
      registry.register(createStubProvider(pc.id, pc.type));
    }

    expect(registry.getAll()).toHaveLength(2);
    expect(registry.has("ollama")).toBe(true);
    expect(registry.has("gemini")).toBe(true);
    expect(registry.has("codex")).toBe(false);
  });

  it("should respect selectionPolicy default-only", () => {
    const raw = {
      defaultProvider: "ollama",
      selectionPolicy: "default-only" as const,
      providers: [
        { id: "ollama", type: "ollama", enabled: true, config: {} },
        { id: "gemini", type: "gemini-cli", enabled: true, config: {} },
      ],
    };
    const config = parseProviderConfig(raw);
    expect(config.selectionPolicy).toBe("default-only");
    expect(config.defaultProvider).toBe("ollama");
  });

  it("should enforce executionPolicy defaults", () => {
    const raw = {
      providers: [
        { id: "a", type: "t", enabled: true, config: {} },
        {
          id: "b",
          type: "t",
          enabled: true,
          executionPolicy: "full-auto" as const,
          config: {},
        },
      ],
    };
    const config = parseProviderConfig(raw);
    expect(config.providers[0].executionPolicy).toBe("read-only");
    expect(config.providers[1].executionPolicy).toBe("full-auto");
  });
});
