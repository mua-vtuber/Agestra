import { describe, it, expect, beforeEach } from "vitest";
import { ProviderRegistry } from "../registry.js";
import type {
  AIProvider,
  ProviderCapability,
  HealthStatus,
  ChatRequest,
  ChatResponse,
} from "../types.js";
import type { QualityStats } from "../trace.js";

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
    chat: async (_req: ChatRequest): Promise<ChatResponse> => ({
      text: "mock",
      model: "mock",
      provider: id,
    }),
  };
}

/**
 * Minimal mock for TraceWriter that only implements getQualityStats.
 * We avoid constructing a real TraceWriter (which requires filesystem).
 */
function createMockTraceWriter(
  statsMap: Map<string, QualityStats>,
): { getQualityStats(daysBack: number): Map<string, QualityStats> } {
  return {
    getQualityStats(_daysBack: number): Map<string, QualityStats> {
      return statsMap;
    },
  };
}

describe("ProviderRegistry - getBestForTask", () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = new ProviderRegistry();
  });

  it("returns provider with highest quality score", () => {
    registry.register(createMockProvider("ollama"));
    registry.register(createMockProvider("gemini"));

    const stats = new Map<string, QualityStats>([
      ["ollama:code_review", { avgScore: 6, count: 3, avgLatencyMs: 1000 }],
      ["gemini:code_review", { avgScore: 9, count: 2, avgLatencyMs: 2000 }],
    ]);

    const result = registry.getBestForTask(
      "code_review",
      createMockTraceWriter(stats),
    );
    expect(result).toBeDefined();
    expect(result!.id).toBe("gemini");
  });

  it("falls back to first available when no quality data exists", () => {
    registry.register(createMockProvider("ollama"));
    registry.register(createMockProvider("gemini"));

    const stats = new Map<string, QualityStats>();
    const result = registry.getBestForTask(
      "code_review",
      createMockTraceWriter(stats),
    );
    expect(result).toBeDefined();
    expect(result!.id).toBe("ollama");
  });

  it("returns undefined when no providers available", () => {
    // Register only unavailable providers
    registry.register(createMockProvider("ollama", false));

    const stats = new Map<string, QualityStats>();
    const result = registry.getBestForTask(
      "code_review",
      createMockTraceWriter(stats),
    );
    expect(result).toBeUndefined();
  });

  it("works with multiple quality samples (uses average)", () => {
    registry.register(createMockProvider("ollama"));
    registry.register(createMockProvider("gemini"));

    // ollama has higher avg from many samples; gemini lower avg from fewer
    const stats = new Map<string, QualityStats>([
      ["ollama:refactor", { avgScore: 7.5, count: 10, avgLatencyMs: 1200 }],
      ["gemini:refactor", { avgScore: 7.0, count: 2, avgLatencyMs: 800 }],
    ]);

    const result = registry.getBestForTask(
      "refactor",
      createMockTraceWriter(stats),
    );
    expect(result).toBeDefined();
    expect(result!.id).toBe("ollama");
  });

  it("only considers available providers", () => {
    registry.register(createMockProvider("ollama", false)); // unavailable but high score
    registry.register(createMockProvider("gemini", true));  // available but lower score

    const stats = new Map<string, QualityStats>([
      ["ollama:code_review", { avgScore: 10, count: 5, avgLatencyMs: 500 }],
      ["gemini:code_review", { avgScore: 5, count: 3, avgLatencyMs: 2000 }],
    ]);

    const result = registry.getBestForTask(
      "code_review",
      createMockTraceWriter(stats),
    );
    expect(result).toBeDefined();
    expect(result!.id).toBe("gemini");
  });

  it("falls back to first available when traceWriter is not provided", () => {
    registry.register(createMockProvider("ollama"));
    registry.register(createMockProvider("gemini"));

    const result = registry.getBestForTask("code_review");
    expect(result).toBeDefined();
    expect(result!.id).toBe("ollama");
  });
});
