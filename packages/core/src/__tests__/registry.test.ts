import { describe, it, expect, beforeEach } from "vitest";
import { ProviderRegistry } from "../registry.js";
import type {
  AIProvider,
  ProviderCapability,
  HealthStatus,
  ChatRequest,
  ChatResponse,
} from "../types.js";

function createMockProvider(
  id: string,
  available = true,
  strengths: string[] = [],
): AIProvider {
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
      strengths,
      models: [],
    }),
    isAvailable: () => available,
    chat: async (req: ChatRequest): Promise<ChatResponse> => ({
      text: "mock",
      model: "mock",
      provider: id,
    }),
  };
}

describe("ProviderRegistry", () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = new ProviderRegistry();
  });

  it("should register and retrieve a provider", () => {
    const p = createMockProvider("test");
    registry.register(p);
    expect(registry.get("test")).toBe(p);
  });

  it("should throw on unknown provider", () => {
    expect(() => registry.get("nope")).toThrow(/not found/i);
  });

  it("should list all providers", () => {
    registry.register(createMockProvider("a"));
    registry.register(createMockProvider("b"));
    expect(registry.getAll()).toHaveLength(2);
  });

  it("should filter available providers", () => {
    registry.register(createMockProvider("up", true));
    registry.register(createMockProvider("down", false));
    expect(registry.getAvailable()).toHaveLength(1);
    expect(registry.getAvailable()[0].id).toBe("up");
  });

  it("should find providers by capability", () => {
    registry.register(createMockProvider("coder", true, ["code_review"]));
    registry.register(
      createMockProvider("translator", true, ["translation"]),
    );
    const coders = registry.getByCapability("code_review");
    expect(coders).toHaveLength(1);
    expect(coders[0].id).toBe("coder");
  });
});
