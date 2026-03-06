import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentLoopChatAdapter } from "../chat-adapter.js";
import type { AIProvider, ChatResponse, ProviderCapability, HealthStatus, ChatRequest } from "@agestra/core";
import type { AgentTool } from "../agent-tools.js";

// Mock AgentLoop
vi.mock("../agent-loop.js", () => ({
  AgentLoop: vi.fn().mockImplementation(() => ({
    run: vi.fn().mockResolvedValue({
      success: true,
      output: "agent loop output",
      iterations: 2,
      toolCalls: [],
    }),
  })),
}));

// Mock buildCapabilityProfile
vi.mock("@agestra/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agestra/core")>();
  return {
    ...actual,
    buildCapabilityProfile: vi.fn((id: string) => ({
      providerId: id,
      tier: id.includes("ollama") ? "tool" : "agent",
      strengths: [],
      maxComplexity: "simple",
    })),
  };
});

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

function mockProvider(id: string, type: string, response: string): AIProvider {
  const provider: AIProvider = {
    id,
    type,
    initialize: async () => {},
    healthCheck: async (): Promise<HealthStatus> => ({ status: "ok" }),
    getCapabilities: (): ProviderCapability => DEFAULT_CAPABILITY,
    isAvailable: () => true,
    chat: vi.fn(async (): Promise<ChatResponse> => ({
      text: response,
      model: "mock",
      provider: id,
    })),
  };
  if (type === "ollama") {
    (provider as any).getConnectionInfo = () => ({ host: "http://localhost:11434", model: "llama3" });
  }
  return provider;
}

function mockTool(name: string): AgentTool {
  return {
    name,
    description: `mock ${name}`,
    parameters: {},
    execute: vi.fn(async () => "ok"),
  };
}

describe("AgentLoopChatAdapter", () => {
  let adapter: AgentLoopChatAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new AgentLoopChatAdapter({
      tools: [mockTool("file_read"), mockTool("file_list"), mockTool("grep_search")],
      baseDir: "/tmp/test",
    });
  });

  it("routes tool-tier Ollama providers through AgentLoop", async () => {
    const provider = mockProvider("ollama", "ollama", "direct response");
    const result = await adapter.chat(provider, { prompt: "test task" });

    expect(result.text).toBe("agent loop output");
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it("routes agent-tier providers through direct chat", async () => {
    const provider = mockProvider("gemini-cli", "gemini", "direct response");
    const result = await adapter.chat(provider, { prompt: "test task" });

    expect(result.text).toBe("direct response");
    expect(provider.chat).toHaveBeenCalledWith({ prompt: "test task" });
  });

  it("falls back to direct chat for non-Ollama tool-tier providers", async () => {
    // "ollama-local" contains "ollama" so tier = "tool", but type is "custom" so no connInfo
    const provider = mockProvider("ollama-local", "custom", "direct response");
    const result = await adapter.chat(provider, { prompt: "test task" });

    expect(result.text).toBe("direct response");
    expect(provider.chat).toHaveBeenCalled();
  });

  it("propagates AgentLoop errors", async () => {
    const { AgentLoop } = await import("../agent-loop.js");
    (AgentLoop as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      run: vi.fn().mockRejectedValue(new Error("loop failed")),
    }));

    const provider = mockProvider("ollama", "ollama", "unused");
    await expect(adapter.chat(provider, { prompt: "test" })).rejects.toThrow("loop failed");
  });
});
