import { describe, it, expect, vi } from "vitest";
import { DebateEngine } from "../debate.js";
import type { EnhancedDebateConfig } from "../debate.js";
import type { AIProvider, ChatResponse, ProviderCapability, HealthStatus, ChatRequest } from "@agestra/core";

function mockProvider(id: string, responses: string[]): AIProvider {
  let callIndex = 0;
  return {
    id, type: "mock",
    initialize: async () => {},
    healthCheck: async (): Promise<HealthStatus> => ({ status: "ok" }),
    getCapabilities: (): ProviderCapability => ({
      maxContext: 4096, supportsSystemPrompt: true, supportsFiles: false,
      supportsStreaming: false, supportsJsonOutput: false, supportsToolUse: false,
      strengths: [], models: [],
    }),
    isAvailable: () => true,
    chat: async (req: ChatRequest): Promise<ChatResponse> => ({
      text: responses[callIndex++] || "no more responses",
      model: "mock", provider: id,
    }),
  };
}

function validationJson(overrides: Record<string, unknown> = {}): string {
  const base = {
    goalAchievement: true,
    completeness: true,
    accuracy: true,
    consistency: true,
    feedback: "All criteria met.",
    ...overrides,
  };
  return JSON.stringify(base);
}

describe("DebateEngine – enhanced mode", () => {
  it("should still work in legacy mode without goal/validator", async () => {
    const a = mockProvider("a", ["round1", "round2"]);
    const engine = new DebateEngine();
    const result = await engine.run({
      topic: "legacy topic",
      providers: [a],
      maxRounds: 2,
    });

    expect(result.rounds).toHaveLength(2);
    expect(result.transcript).toContain("legacy topic");
  });

  it("should run validation after minRounds", async () => {
    const chatSpy = vi.fn<(req: ChatRequest) => Promise<ChatResponse>>();
    // Validator will be called once after round 2 (minRounds=2)
    chatSpy.mockResolvedValueOnce({
      text: validationJson(),
      model: "mock", provider: "validator",
    });

    const validator: AIProvider = {
      id: "validator", type: "mock",
      initialize: async () => {},
      healthCheck: async (): Promise<HealthStatus> => ({ status: "ok" }),
      getCapabilities: (): ProviderCapability => ({
        maxContext: 4096, supportsSystemPrompt: true, supportsFiles: false,
        supportsStreaming: false, supportsJsonOutput: false, supportsToolUse: false,
        strengths: [], models: [],
      }),
      isAvailable: () => true,
      chat: chatSpy,
    };

    const a = mockProvider("a", ["r1", "r2", "r3"]);
    const engine = new DebateEngine();

    const config: EnhancedDebateConfig = {
      topic: "enhanced topic",
      providers: [a],
      maxRounds: 5,
      goal: "reach consensus on architecture",
      validator,
      minRounds: 2,
    };

    const result = await engine.run(config);

    // Validator should have been called after round 2
    expect(chatSpy).toHaveBeenCalledTimes(1);
    // All criteria passed, so debate stops at round 2
    expect(result.rounds).toHaveLength(2);
  });

  it("should stop when all criteria pass", async () => {
    const validatorResponses = [
      validationJson({ goalAchievement: false, feedback: "Goal not yet achieved" }),
      validationJson(), // all pass on second validation
    ];
    let vIdx = 0;
    const validator = mockProvider("validator", validatorResponses);

    const a = mockProvider("a", ["r1", "r2", "r3", "r4"]);
    const engine = new DebateEngine();

    const config: EnhancedDebateConfig = {
      topic: "quality topic",
      providers: [a],
      maxRounds: 5,
      goal: "decide on database",
      validator,
      minRounds: 1,
    };

    const result = await engine.run(config);

    // Round 1: validation fails → round 2: validation passes → stop
    expect(result.rounds).toHaveLength(2);
  });

  it("should continue when criteria fail and include feedback", async () => {
    const chatSpy = vi.fn<(req: ChatRequest) => Promise<ChatResponse>>();

    // Validation after round 2: fail
    chatSpy.mockResolvedValueOnce({
      text: validationJson({ completeness: false, feedback: "Missing error handling discussion" }),
      model: "mock", provider: "validator",
    });
    // Validation after round 3: pass
    chatSpy.mockResolvedValueOnce({
      text: validationJson(),
      model: "mock", provider: "validator",
    });

    const validator: AIProvider = {
      id: "validator", type: "mock",
      initialize: async () => {},
      healthCheck: async (): Promise<HealthStatus> => ({ status: "ok" }),
      getCapabilities: (): ProviderCapability => ({
        maxContext: 4096, supportsSystemPrompt: true, supportsFiles: false,
        supportsStreaming: false, supportsJsonOutput: false, supportsToolUse: false,
        strengths: [], models: [],
      }),
      isAvailable: () => true,
      chat: chatSpy,
    };

    const debaterChat = vi.fn<(req: ChatRequest) => Promise<ChatResponse>>();
    debaterChat.mockResolvedValueOnce({ text: "r1", model: "mock", provider: "debater" });
    debaterChat.mockResolvedValueOnce({ text: "r2", model: "mock", provider: "debater" });
    debaterChat.mockResolvedValueOnce({ text: "r3", model: "mock", provider: "debater" });

    const debater: AIProvider = {
      id: "debater", type: "mock",
      initialize: async () => {},
      healthCheck: async (): Promise<HealthStatus> => ({ status: "ok" }),
      getCapabilities: (): ProviderCapability => ({
        maxContext: 4096, supportsSystemPrompt: true, supportsFiles: false,
        supportsStreaming: false, supportsJsonOutput: false, supportsToolUse: false,
        strengths: [], models: [],
      }),
      isAvailable: () => true,
      chat: debaterChat,
    };

    const engine = new DebateEngine();
    const config: EnhancedDebateConfig = {
      topic: "feedback topic",
      providers: [debater],
      maxRounds: 5,
      goal: "complete architecture",
      validator,
      minRounds: 2,
    };

    const result = await engine.run(config);

    expect(result.rounds).toHaveLength(3);
    // Round 3 prompt should include validator feedback
    const round3Call = debaterChat.mock.calls[2];
    expect(round3Call[0].prompt).toContain("Missing error handling discussion");
  });

  it("should respect maxRounds limit even when criteria keep failing", async () => {
    const failResponse = validationJson({
      goalAchievement: false,
      feedback: "Still not there",
    });
    // Validator always fails
    const validator = mockProvider("validator", [
      failResponse, failResponse, failResponse, failResponse,
    ]);

    const a = mockProvider("a", ["r1", "r2", "r3", "r4"]);
    const engine = new DebateEngine();

    const config: EnhancedDebateConfig = {
      topic: "max rounds topic",
      providers: [a],
      maxRounds: 3,
      goal: "unreachable goal",
      validator,
      minRounds: 1,
    };

    const result = await engine.run(config);

    // Should stop at maxRounds=3 even though validation never passes
    expect(result.rounds).toHaveLength(3);
    expect(result.consensusDocument).toContain("max rounds topic");
  });

  it("should handle malformed validator JSON gracefully", async () => {
    const validator = mockProvider("validator", [
      "this is not valid json at all",
      validationJson(), // second call passes
    ]);

    const a = mockProvider("a", ["r1", "r2", "r3"]);
    const engine = new DebateEngine();

    const config: EnhancedDebateConfig = {
      topic: "malformed json topic",
      providers: [a],
      maxRounds: 5,
      goal: "test goal",
      validator,
      minRounds: 1,
    };

    const result = await engine.run(config);

    // Round 1: malformed → fails, round 2: passes → stop
    expect(result.rounds).toHaveLength(2);
  });

  it("should default minRounds to 2 when not specified", async () => {
    const validatorChat = vi.fn<(req: ChatRequest) => Promise<ChatResponse>>();
    validatorChat.mockResolvedValue({
      text: validationJson(),
      model: "mock", provider: "validator",
    });

    const validator: AIProvider = {
      id: "validator", type: "mock",
      initialize: async () => {},
      healthCheck: async (): Promise<HealthStatus> => ({ status: "ok" }),
      getCapabilities: (): ProviderCapability => ({
        maxContext: 4096, supportsSystemPrompt: true, supportsFiles: false,
        supportsStreaming: false, supportsJsonOutput: false, supportsToolUse: false,
        strengths: [], models: [],
      }),
      isAvailable: () => true,
      chat: validatorChat,
    };

    const a = mockProvider("a", ["r1", "r2"]);
    const engine = new DebateEngine();

    const config: EnhancedDebateConfig = {
      topic: "default minRounds",
      providers: [a],
      maxRounds: 5,
      goal: "test",
      validator,
      // minRounds not specified, should default to 2
    };

    const result = await engine.run(config);

    // Validation shouldn't happen until round 2, then passes
    expect(result.rounds).toHaveLength(2);
    // Validator called once (after round 2)
    expect(validatorChat).toHaveBeenCalledTimes(1);
  });
});
