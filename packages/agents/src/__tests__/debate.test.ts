import { describe, it, expect } from "vitest";
import { DebateEngine } from "../debate.js";
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

describe("DebateEngine", () => {
  // ── Legacy round-based tests ──────────────────────────────

  it("should run a debate with rounds", async () => {
    const gemini = mockProvider("gemini", [
      "I think we should use React",
      "After considering, I still prefer React",
    ]);
    const codex = mockProvider("codex", [
      "Vue is better for this use case",
      "I see your point, let's compromise on React",
    ]);

    const engine = new DebateEngine();
    const result = await engine.run({
      topic: "Which framework for the frontend?",
      providers: [gemini, codex],
      maxRounds: 2,
    });

    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0]).toHaveLength(2);
    expect(result.transcript).toContain("React");
    expect(result.transcript).toContain("Vue");
  });

  it("should generate a consensus document", async () => {
    const a = mockProvider("a", ["opinion A"]);
    const b = mockProvider("b", ["opinion B"]);

    const engine = new DebateEngine();
    const result = await engine.run({
      topic: "test topic",
      providers: [a, b],
      maxRounds: 1,
    });

    expect(result.consensusDocument).toContain("test topic");
    expect(result.consensusDocument).toContain("opinion A");
    expect(result.consensusDocument).toContain("opinion B");
  });

  it("should handle single round debate", async () => {
    const a = mockProvider("a", ["my view"]);
    const engine = new DebateEngine();
    const result = await engine.run({
      topic: "topic",
      providers: [a],
      maxRounds: 1,
    });
    expect(result.rounds).toHaveLength(1);
  });

  // ── Turn-based stateful tests ──────────────────────────────

  describe("create()", () => {
    it("should create a debate state and return an ID", () => {
      const engine = new DebateEngine();
      const state = engine.create({
        topic: "API design",
        providerIds: ["gemini", "codex"],
      });

      expect(state.id).toBeTruthy();
      expect(state.topic).toBe("API design");
      expect(state.providerIds).toEqual(["gemini", "codex"]);
      expect(state.turns).toHaveLength(0);
      expect(state.status).toBe("active");
      expect(state.createdAt).toBeTruthy();
    });

    it("should store goal and documentId", () => {
      const engine = new DebateEngine();
      const state = engine.create({
        topic: "test",
        providerIds: ["a"],
        goal: "reach consensus",
        documentId: "doc-123",
      });

      expect(state.goal).toBe("reach consensus");
      expect(state.documentId).toBe("doc-123");
    });

    it("should store debate state for retrieval", () => {
      const engine = new DebateEngine();
      const state = engine.create({
        topic: "test",
        providerIds: ["a"],
      });

      const retrieved = engine.getState(state.id);
      expect(retrieved).toBe(state);
    });
  });

  describe("addTurn()", () => {
    it("should append turns and preserve order", () => {
      const engine = new DebateEngine();
      const state = engine.create({
        topic: "test",
        providerIds: ["gemini", "codex"],
      });

      engine.addTurn(state.id, "gemini", "I think REST is better");
      engine.addTurn(state.id, "claude", "What about GraphQL?");
      engine.addTurn(state.id, "codex", "I agree with Claude");

      expect(state.turns).toHaveLength(3);
      expect(state.turns[0].turnNumber).toBe(1);
      expect(state.turns[0].speaker).toBe("gemini");
      expect(state.turns[0].content).toBe("I think REST is better");
      expect(state.turns[1].turnNumber).toBe(2);
      expect(state.turns[1].speaker).toBe("claude");
      expect(state.turns[2].turnNumber).toBe(3);
      expect(state.turns[2].speaker).toBe("codex");
    });

    it("should throw for non-existent debate", () => {
      const engine = new DebateEngine();
      expect(() => engine.addTurn("bad-id", "a", "text")).toThrow("Debate not found");
    });

    it("should throw for concluded debate", () => {
      const engine = new DebateEngine();
      const state = engine.create({
        topic: "test",
        providerIds: ["a"],
      });
      engine.conclude(state.id);
      expect(() => engine.addTurn(state.id, "a", "text")).toThrow("Debate already concluded");
    });
  });

  describe("buildPromptForProvider()", () => {
    it("should include all previous turns in prompt", () => {
      const engine = new DebateEngine();
      const state = engine.create({
        topic: "API design",
        providerIds: ["gemini", "codex"],
        goal: "Choose the best API style",
      });

      engine.addTurn(state.id, "gemini", "REST is simple");
      engine.addTurn(state.id, "claude", "Consider GraphQL");

      const prompt = engine.buildPromptForProvider(state.id, "codex");

      expect(prompt).toContain("Topic: API design");
      expect(prompt).toContain("Goal: Choose the best API style");
      expect(prompt).toContain("[Turn 1] gemini:");
      expect(prompt).toContain("REST is simple");
      expect(prompt).toContain("[Turn 2] claude:");
      expect(prompt).toContain("Consider GraphQL");
      expect(prompt).toContain("You are codex");
    });

    it("should handle empty history", () => {
      const engine = new DebateEngine();
      const state = engine.create({
        topic: "test topic",
        providerIds: ["a"],
      });

      const prompt = engine.buildPromptForProvider(state.id, "a");
      expect(prompt).toContain("Topic: test topic");
      expect(prompt).toContain("You are a");
      expect(prompt).not.toContain("Conversation History");
    });

    it("should omit goal if not set", () => {
      const engine = new DebateEngine();
      const state = engine.create({
        topic: "test",
        providerIds: ["a"],
      });

      const prompt = engine.buildPromptForProvider(state.id, "a");
      expect(prompt).not.toContain("Goal:");
    });
  });

  describe("conclude()", () => {
    it("should mark debate as concluded", () => {
      const engine = new DebateEngine();
      const state = engine.create({
        topic: "test",
        providerIds: ["a"],
      });
      engine.addTurn(state.id, "a", "my opinion");

      const result = engine.conclude(state.id);
      expect(result.status).toBe("concluded");
    });

    it("should throw for non-existent debate", () => {
      const engine = new DebateEngine();
      expect(() => engine.conclude("bad-id")).toThrow("Debate not found");
    });
  });

  describe("buildTurnTranscript()", () => {
    it("should build a full transcript", () => {
      const engine = new DebateEngine();
      const state = engine.create({
        topic: "API design",
        providerIds: ["gemini", "codex"],
        goal: "Decide on API style",
      });

      engine.addTurn(state.id, "gemini", "REST is proven");
      engine.addTurn(state.id, "claude", "GraphQL is flexible");
      engine.addTurn(state.id, "codex", "REST for simple cases");

      const transcript = engine.buildTurnTranscript(state.id);
      expect(transcript).toContain("# Debate: API design");
      expect(transcript).toContain("**Goal:** Decide on API style");
      expect(transcript).toContain("**Participants:** gemini, codex");
      expect(transcript).toContain("[Turn 1] gemini");
      expect(transcript).toContain("REST is proven");
      expect(transcript).toContain("[Turn 2] claude");
      expect(transcript).toContain("[Turn 3] codex");
    });
  });
});
