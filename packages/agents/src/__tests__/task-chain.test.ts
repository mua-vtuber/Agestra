import { describe, it, expect, vi, beforeEach } from "vitest";
import { TaskChainEngine } from "../task-chain.js";
import type { AIProvider, ProviderRegistry, ChatResponse, ProviderCapability, HealthStatus } from "@agestra/core";
import type { ChatAdapter } from "../chat-adapter.js";

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

function mockProvider(id: string): AIProvider {
  return {
    id,
    type: "mock",
    initialize: async () => {},
    healthCheck: async (): Promise<HealthStatus> => ({ status: "ok" }),
    getCapabilities: (): ProviderCapability => DEFAULT_CAPABILITY,
    isAvailable: () => true,
    chat: vi.fn(async (): Promise<ChatResponse> => ({
      text: `response from ${id}`,
      model: "mock",
      provider: id,
    })),
  };
}

function mockChatAdapter(responses?: Map<string, string>): ChatAdapter {
  return {
    chat: vi.fn(async (provider: AIProvider, request: { prompt: string }): Promise<ChatResponse> => {
      const text = responses?.get(provider.id) ?? `response from ${provider.id}`;
      return { text, model: "mock", provider: provider.id };
    }),
  };
}

function mockRegistry(providers: AIProvider[]): ProviderRegistry {
  const map = new Map(providers.map((p) => [p.id, p]));
  return {
    get: (id: string) => {
      const p = map.get(id);
      if (!p) throw new Error(`Provider not found: ${id}`);
      return p;
    },
    getAvailable: () => providers,
    getAll: () => providers,
    has: (id: string) => map.has(id),
  } as unknown as ProviderRegistry;
}

describe("TaskChainEngine", () => {
  let engine: TaskChainEngine;
  let adapter: ChatAdapter;
  let gemini: AIProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    gemini = mockProvider("gemini");
    adapter = mockChatAdapter();
    engine = new TaskChainEngine(adapter, mockRegistry([gemini]));
  });

  describe("create", () => {
    it("should create a chain with initial state", () => {
      const state = engine.create({
        steps: [
          { id: "s1", description: "step 1", prompt: "do thing", provider: "gemini" },
        ],
      });

      expect(state.id).toBeDefined();
      expect(state.status).toBe("created");
      expect(state.steps).toHaveLength(1);
      expect(state.results).toHaveLength(0);
      expect(state.currentStepIndex).toBe(0);
    });
  });

  describe("executeStep", () => {
    it("should execute the first step and return result", async () => {
      const state = engine.create({
        steps: [
          { id: "s1", description: "analyze", prompt: "analyze code", provider: "gemini" },
        ],
      });

      const result = await engine.executeStep(state.id);

      expect(result.stepId).toBe("s1");
      expect(result.status).toBe("completed");
      expect(result.output).toBe("response from gemini");
      expect(adapter.chat).toHaveBeenCalledTimes(1);
    });

    it("should chain context from previous steps", async () => {
      const state = engine.create({
        steps: [
          { id: "s1", description: "analyze", prompt: "analyze code", provider: "gemini" },
          { id: "s2", description: "plan", prompt: "make a plan", provider: "gemini", dependsOn: ["s1"] },
        ],
      });

      await engine.executeStep(state.id);
      await engine.executeStep(state.id);

      const calls = (adapter.chat as ReturnType<typeof vi.fn>).mock.calls;
      const secondPrompt = calls[1][1].prompt as string;
      expect(secondPrompt).toContain("=== Previous Results ===");
      expect(secondPrompt).toContain("[Step s1]");
      expect(secondPrompt).toContain("response from gemini");
      expect(secondPrompt).toContain("make a plan");
    });

    it("should pause at checkpoint", async () => {
      const state = engine.create({
        steps: [
          { id: "s1", description: "step 1", prompt: "do thing", provider: "gemini", checkpoint: true },
          { id: "s2", description: "step 2", prompt: "next thing", provider: "gemini" },
        ],
      });

      await engine.executeStep(state.id);

      const updated = engine.getState(state.id)!;
      expect(updated.status).toBe("paused");
      expect(updated.currentStepIndex).toBe(1);
    });

    it("should mark chain completed after last step", async () => {
      const state = engine.create({
        steps: [
          { id: "s1", description: "only step", prompt: "do it", provider: "gemini" },
        ],
      });

      await engine.executeStep(state.id);

      const updated = engine.getState(state.id)!;
      expect(updated.status).toBe("completed");
    });

    it("should reject execution with unmet dependencies", async () => {
      const state = engine.create({
        steps: [
          { id: "s1", description: "first", prompt: "a", provider: "gemini" },
          { id: "s2", description: "second", prompt: "b", provider: "gemini", dependsOn: ["s1"] },
        ],
      });

      await expect(engine.executeStep(state.id, "s2")).rejects.toThrow("Unmet dependencies");
    });

    it("should support overridePrompt", async () => {
      const state = engine.create({
        steps: [
          { id: "s1", description: "step", prompt: "original", provider: "gemini" },
        ],
      });

      await engine.executeStep(state.id, undefined, "overridden prompt");

      const calls = (adapter.chat as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0][1].prompt).toBe("overridden prompt");
    });

    it("should handle provider errors gracefully", async () => {
      const failAdapter: ChatAdapter = {
        chat: vi.fn(async () => { throw new Error("provider down"); }),
      };
      const failEngine = new TaskChainEngine(failAdapter, mockRegistry([gemini]));

      const state = failEngine.create({
        steps: [{ id: "s1", description: "fail", prompt: "x", provider: "gemini" }],
      });

      const result = await failEngine.executeStep(state.id);
      expect(result.status).toBe("error");
      expect(result.output).toContain("provider down");

      const updated = failEngine.getState(state.id)!;
      expect(updated.status).toBe("failed");
    });

    it("should error on already completed chain", async () => {
      const state = engine.create({
        steps: [{ id: "s1", description: "x", prompt: "x", provider: "gemini" }],
      });
      await engine.executeStep(state.id);

      await expect(engine.executeStep(state.id)).rejects.toThrow("already completed");
    });
  });

  describe("delete", () => {
    it("should remove chain state", () => {
      const state = engine.create({ steps: [] });
      expect(engine.delete(state.id)).toBe(true);
      expect(engine.getState(state.id)).toBeUndefined();
    });
  });
});
