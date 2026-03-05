import { describe, it, expect, vi } from "vitest";
import { CrossValidator } from "../cross-validator.js";
import type { ChatAdapter } from "../chat-adapter.js";
import type {
  AIProvider,
  ChatResponse,
  ProviderCapability,
  ProviderRegistry,
  HealthStatus,
  ChatRequest,
} from "@agestra/core";

const DEFAULT_CAPABILITY: ProviderCapability = {
  maxContext: 4096,
  supportsSystemPrompt: true,
  supportsFiles: false,
  supportsStreaming: false,
  supportsJsonOutput: false,
  supportsToolUse: false,
  strengths: [],
  models: [],
};

function mockProvider(id: string, response: string): AIProvider {
  return {
    id,
    type: "mock",
    initialize: async () => {},
    healthCheck: async (): Promise<HealthStatus> => ({ status: "ok" }),
    getCapabilities: (): ProviderCapability => DEFAULT_CAPABILITY,
    isAvailable: () => true,
    chat: async (_req: ChatRequest): Promise<ChatResponse> => ({
      text: response,
      model: "mock",
      provider: id,
    }),
  };
}

function createMockRegistry(
  providers: AIProvider[],
  tiers: Record<string, "tool" | "agent">,
): ProviderRegistry {
  const providerMap = new Map<string, AIProvider>();
  for (const p of providers) {
    providerMap.set(p.id, p);
  }

  return {
    register: vi.fn(),
    get: (id: string) => {
      const p = providerMap.get(id);
      if (!p) throw new Error(`Provider not found: ${id}`);
      return p;
    },
    getAll: () => [...providerMap.values()],
    getAvailable: () => [...providerMap.values()],
    getByCapability: vi.fn(() => []),
    has: (id: string) => providerMap.has(id),
    getCapability: (providerId: string) => ({
      providerId,
      tier: tiers[providerId] ?? "tool",
      strengths: [],
      maxComplexity: tiers[providerId] === "agent" ? "complex" as const : "simple" as const,
    }),
    getByTier: vi.fn(() => []),
  } as unknown as ProviderRegistry;
}

describe("CrossValidator", () => {
  it("should exclude tool-tier providers as validators", async () => {
    const toolProvider = mockProvider(
      "ollama",
      '{ "passed": true, "feedback": "ok" }',
    );
    const agentProvider = mockProvider(
      "gemini-cli",
      '{ "passed": true, "feedback": "looks good" }',
    );
    const registry = createMockRegistry([toolProvider, agentProvider], {
      ollama: "tool",
      "gemini-cli": "agent",
    });

    const validator = new CrossValidator(registry);
    const result = await validator.validate({
      items: [
        { providerId: "ollama", content: "some code", task: "write tests" },
        {
          providerId: "gemini-cli",
          content: "other code",
          task: "write tests",
        },
      ],
    });

    // ollama is tool-tier so it should not appear as a reviewer
    const reviewerIds = result.reviews.map((r) => r.reviewerProvider);
    expect(reviewerIds).not.toContain("ollama");
    // gemini-cli should review ollama's work
    expect(reviewerIds).toContain("gemini-cli");
  });

  it("should cross-validate with passing reviews", async () => {
    const providerA = mockProvider(
      "gemini-cli",
      '{ "passed": true, "feedback": "well structured code" }',
    );
    const providerB = mockProvider(
      "codex-cli",
      '{ "passed": true, "feedback": "correct implementation" }',
    );
    const registry = createMockRegistry([providerA, providerB], {
      "gemini-cli": "agent",
      "codex-cli": "agent",
    });

    const validator = new CrossValidator(registry);
    const result = await validator.validate({
      items: [
        {
          providerId: "gemini-cli",
          content: "function add(a, b) { return a + b; }",
          task: "implement addition",
        },
        {
          providerId: "codex-cli",
          content: "function sub(a, b) { return a - b; }",
          task: "implement subtraction",
        },
      ],
    });

    expect(result.overallPass).toBe(true);
    expect(result.reviews).toHaveLength(2);
    expect(result.conflicts).toHaveLength(0);
    // codex-cli reviews gemini-cli's work and vice versa
    expect(result.reviews[0].targetProvider).toBe("gemini-cli");
    expect(result.reviews[0].reviewerProvider).toBe("codex-cli");
    expect(result.reviews[1].targetProvider).toBe("codex-cli");
    expect(result.reviews[1].reviewerProvider).toBe("gemini-cli");
  });

  it("should cross-validate with failing reviews", async () => {
    const providerA = mockProvider(
      "gemini-cli",
      '{ "passed": false, "feedback": "missing error handling", "suggestedFixes": "add try-catch" }',
    );
    const providerB = mockProvider(
      "codex-cli",
      '{ "passed": false, "feedback": "incomplete implementation" }',
    );
    const registry = createMockRegistry([providerA, providerB], {
      "gemini-cli": "agent",
      "codex-cli": "agent",
    });

    const validator = new CrossValidator(registry);
    const result = await validator.validate({
      items: [
        {
          providerId: "gemini-cli",
          content: "buggy code",
          task: "implement feature",
        },
        {
          providerId: "codex-cli",
          content: "incomplete code",
          task: "implement feature",
        },
      ],
    });

    expect(result.overallPass).toBe(false);
    expect(result.reviews).toHaveLength(2);
    // gemini-cli reviews codex-cli's work
    const codexReview = result.reviews.find(
      (r) => r.targetProvider === "codex-cli",
    );
    expect(codexReview?.passed).toBe(false);
    expect(codexReview?.feedback).toBe("missing error handling");
    expect(codexReview?.suggestedFixes).toBe("add try-catch");
  });

  it("should detect conflicts when validators disagree", async () => {
    const passingValidator = mockProvider(
      "gemini-cli",
      '{ "passed": true, "feedback": "looks fine" }',
    );
    const failingValidator = mockProvider(
      "codex-cli",
      '{ "passed": false, "feedback": "has issues" }',
    );
    const targetProvider = mockProvider(
      "target-agent",
      "not used for validation",
    );
    const registry = createMockRegistry(
      [passingValidator, failingValidator, targetProvider],
      {
        "gemini-cli": "agent",
        "codex-cli": "agent",
        "target-agent": "agent",
      },
    );

    const validator = new CrossValidator(registry);
    const result = await validator.validate({
      items: [
        {
          providerId: "target-agent",
          content: "some code",
          task: "implement feature",
        },
      ],
      validators: [passingValidator, failingValidator],
    });

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toContain("target-agent");
    expect(result.conflicts[0]).toContain("gemini-cli");
    expect(result.conflicts[0]).toContain("codex-cli");
    expect(result.overallPass).toBe(false);
  });

  it("should handle non-JSON responses with fallback", async () => {
    const provider = mockProvider(
      "gemini-cli",
      "This is not JSON, just plain text feedback",
    );
    const target = mockProvider("codex-cli", "unused");
    const registry = createMockRegistry([provider, target], {
      "gemini-cli": "agent",
      "codex-cli": "agent",
    });

    const validator = new CrossValidator(registry);
    const result = await validator.validate({
      items: [
        { providerId: "codex-cli", content: "some code", task: "review" },
      ],
      validators: [provider],
    });

    expect(result.reviews).toHaveLength(1);
    expect(result.reviews[0].passed).toBe(false);
    expect(result.reviews[0].feedback).toBe(
      "This is not JSON, just plain text feedback",
    );
  });

  it("returns message when no validators available", async () => {
    const toolOnlyProvider = mockProvider(
      "ollama-tiny",
      '{ "passed": true, "feedback": "ok" }',
    );
    const registry = createMockRegistry([toolOnlyProvider], {
      "ollama-tiny": "tool",
    });

    const validator = new CrossValidator(registry);
    const result = await validator.validate({
      items: [
        { providerId: "ollama-tiny", content: "some code", task: "review" },
      ],
    });

    expect(result.overallPass).toBe(false);
    expect(result.reviews).toHaveLength(0);
    expect(result.message).toBe(
      "No agent-tier validators available for cross-validation.",
    );
  });

  it("should use custom criteria in the review prompt", async () => {
    let capturedPrompt = "";
    const reviewerProvider: AIProvider = {
      id: "gemini-cli",
      type: "mock",
      initialize: async () => {},
      healthCheck: async (): Promise<HealthStatus> => ({ status: "ok" }),
      getCapabilities: (): ProviderCapability => DEFAULT_CAPABILITY,
      isAvailable: () => true,
      chat: async (req: ChatRequest): Promise<ChatResponse> => {
        capturedPrompt = req.prompt;
        return {
          text: '{ "passed": true, "feedback": "meets criteria" }',
          model: "mock",
          provider: "gemini-cli",
        };
      },
    };
    const target = mockProvider("codex-cli", "unused");
    const registry = createMockRegistry([reviewerProvider, target], {
      "gemini-cli": "agent",
      "codex-cli": "agent",
    });

    const validator = new CrossValidator(registry);
    await validator.validate({
      items: [
        { providerId: "codex-cli", content: "code", task: "implement" },
      ],
      validators: [reviewerProvider],
      criteria: "Must follow SOLID principles",
    });

    expect(capturedPrompt).toContain("Must follow SOLID principles");
  });

  describe("CrossValidator with ChatAdapter", () => {
    it("should route review calls through adapter", async () => {
      const chatCalls: string[] = [];
      const adapter: ChatAdapter = {
        async chat(provider, request) {
          chatCalls.push(provider.id);
          return {
            text: '{ "passed": true, "feedback": "reviewed via adapter" }',
            model: "mock",
            provider: provider.id,
          };
        },
      };

      const providerA = mockProvider("gemini-cli", "unused");
      const providerB = mockProvider("codex-cli", "unused");
      const registry = createMockRegistry([providerA, providerB], {
        "gemini-cli": "agent",
        "codex-cli": "agent",
      });

      const validator = new CrossValidator(registry, adapter);
      const result = await validator.validate({
        items: [
          { providerId: "gemini-cli", content: "code", task: "review" },
          { providerId: "codex-cli", content: "code", task: "review" },
        ],
      });

      expect(chatCalls).toContain("gemini-cli");
      expect(chatCalls).toContain("codex-cli");
      expect(result.reviews[0].feedback).toBe("reviewed via adapter");
    });

    it("should allow tool-tier validators when adapter is provided", async () => {
      const adapter: ChatAdapter = {
        async chat(provider, request) {
          return {
            text: '{ "passed": true, "feedback": "tool-tier reviewed" }',
            model: "mock",
            provider: provider.id,
          };
        },
      };

      const toolProvider = mockProvider("ollama", '{ "passed": true, "feedback": "ok" }');
      const agentProvider = mockProvider("gemini-cli", '{ "passed": true, "feedback": "ok" }');
      const registry = createMockRegistry([toolProvider, agentProvider], {
        ollama: "tool",
        "gemini-cli": "agent",
      });

      const validator = new CrossValidator(registry, adapter);
      const result = await validator.validate({
        items: [
          { providerId: "gemini-cli", content: "code", task: "review" },
        ],
        validators: [toolProvider],
      });

      const reviewerIds = result.reviews.map((r) => r.reviewerProvider);
      expect(reviewerIds).toContain("ollama");
    });

    it("should still exclude tool-tier when no adapter", async () => {
      const toolProvider = mockProvider("ollama", '{ "passed": true, "feedback": "ok" }');
      const registry = createMockRegistry([toolProvider], { ollama: "tool" });

      const validator = new CrossValidator(registry);
      const result = await validator.validate({
        items: [{ providerId: "ollama", content: "code", task: "review" }],
      });

      expect(result.reviews).toHaveLength(0);
      expect(result.message).toBe("No agent-tier validators available for cross-validation.");
    });
  });
});
