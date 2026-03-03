import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTools, handleTool, type OllamaToolDeps } from "../tools/ollama-manage.js";
import type {
  AIProvider,
  ChatRequest,
  ChatResponse,
  ProviderCapability,
  HealthStatus,
  ProviderRegistry,
} from "@agestra/core";

// ── Mock helpers ─────────────────────────────────────────────

interface MockOllamaModel {
  name: string;
  size: number;
  strengths: string[];
}

function mockOllamaProvider(
  id: string,
  models: MockOllamaModel[] = [],
  host = "http://localhost:11434",
): AIProvider & { getModels: () => MockOllamaModel[]; host: string } {
  return {
    id,
    type: "ollama",
    host,
    initialize: async () => {},
    healthCheck: async (): Promise<HealthStatus> => ({ status: "ok" }),
    getCapabilities: (): ProviderCapability => ({
      maxContext: 32768,
      supportsSystemPrompt: true,
      supportsFiles: false,
      supportsStreaming: true,
      supportsJsonOutput: false,
      supportsToolUse: true,
      strengths: [],
      models: [],
    }),
    isAvailable: () => true,
    chat: async (_req: ChatRequest): Promise<ChatResponse> => ({
      text: "response",
      model: "llama3",
      provider: id,
    }),
    getModels: () => [...models],
  };
}

function mockNonOllamaProvider(id: string): AIProvider {
  return {
    id,
    type: "gemini-cli",
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
    chat: async (_req: ChatRequest): Promise<ChatResponse> => ({
      text: "response",
      model: "mock",
      provider: id,
    }),
  };
}

function mockRegistry(providers: AIProvider[]): ProviderRegistry {
  const map = new Map<string, AIProvider>();
  for (const p of providers) {
    map.set(p.id, p);
  }
  return {
    register: vi.fn(),
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

describe("ollama-manage tools", () => {
  // Mock global fetch
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("getTools", () => {
    it("should return 2 tool definitions", () => {
      const tools = getTools();
      expect(tools).toHaveLength(2);
      const names = tools.map((t) => t.name);
      expect(names).toContain("ollama_models");
      expect(names).toContain("ollama_pull");
    });

    it("should have valid inputSchema for each tool", () => {
      const tools = getTools();
      for (const tool of tools) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe("object");
        expect(tool.description).toBeTruthy();
      }
    });
  });

  describe("ollama_models", () => {
    it("should list installed models with details", async () => {
      const deps: OllamaToolDeps = {
        registry: mockRegistry([
          mockOllamaProvider("ollama", [
            { name: "llama3:latest", size: 4_700_000_000, strengths: ["chat"] },
            { name: "codellama:7b", size: 3_800_000_000, strengths: ["chat", "code_review", "code_generation"] },
          ]),
        ]),
      };

      const result = await handleTool("ollama_models", {}, deps);

      const text = result.content[0].text;
      expect(text).toContain("Installed Ollama Models (2)");
      expect(text).toContain("llama3:latest");
      expect(text).toContain("4.7 GB");
      expect(text).toContain("codellama:7b");
      expect(text).toContain("3.8 GB");
      expect(text).toContain("code_review, code_generation");
    });

    it("should show message when no models installed", async () => {
      const deps: OllamaToolDeps = {
        registry: mockRegistry([
          mockOllamaProvider("ollama", []),
        ]),
      };

      const result = await handleTool("ollama_models", {}, deps);
      expect(result.content[0].text).toContain("No models installed");
      expect(result.content[0].text).toContain("ollama_pull");
    });

    it("should throw when ollama provider not found", async () => {
      const deps: OllamaToolDeps = {
        registry: mockRegistry([]),
      };

      await expect(
        handleTool("ollama_models", {}, deps),
      ).rejects.toThrow("Provider not found");
    });

    it("should throw when provider is not ollama type", async () => {
      const deps: OllamaToolDeps = {
        registry: mockRegistry([mockNonOllamaProvider("ollama")]),
      };

      await expect(
        handleTool("ollama_models", {}, deps),
      ).rejects.toThrow("not an Ollama provider");
    });

    it("should use custom provider ID from deps", async () => {
      const deps: OllamaToolDeps = {
        registry: mockRegistry([
          mockOllamaProvider("my-ollama", [
            { name: "llama3", size: 4_700_000_000, strengths: ["chat"] },
          ]),
        ]),
        ollamaProviderId: "my-ollama",
      };

      const result = await handleTool("ollama_models", {}, deps);
      expect(result.content[0].text).toContain("llama3");
    });
  });

  describe("ollama_pull", () => {
    it("should pull a model successfully", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: "success" }),
      });
      globalThis.fetch = mockFetch;

      const deps: OllamaToolDeps = {
        registry: mockRegistry([
          mockOllamaProvider("ollama", [], "http://localhost:11434"),
        ]),
      };

      const result = await handleTool(
        "ollama_pull",
        { model: "llama3" },
        deps,
      );

      const text = result.content[0].text;
      expect(text).toContain("Model pulled successfully");
      expect(text).toContain("llama3");
      expect(text).toContain("success");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:11434/api/pull",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ name: "llama3", stream: false }),
        }),
      );

      globalThis.fetch = originalFetch;
    });

    it("should handle pull API error", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => "model not found",
      });
      globalThis.fetch = mockFetch;

      const deps: OllamaToolDeps = {
        registry: mockRegistry([
          mockOllamaProvider("ollama", [], "http://localhost:11434"),
        ]),
      };

      const result = await handleTool(
        "ollama_pull",
        { model: "nonexistent-model" },
        deps,
      );

      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toContain("Pull failed");
      expect(text).toContain("nonexistent-model");
      expect(text).toContain("404");

      globalThis.fetch = originalFetch;
    });

    it("should handle network error during pull", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("Connection refused"));
      globalThis.fetch = mockFetch;

      const deps: OllamaToolDeps = {
        registry: mockRegistry([
          mockOllamaProvider("ollama", [], "http://localhost:11434"),
        ]),
      };

      const result = await handleTool(
        "ollama_pull",
        { model: "llama3" },
        deps,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Connection refused");

      globalThis.fetch = originalFetch;
    });

    it("should throw for missing model parameter", async () => {
      const deps: OllamaToolDeps = {
        registry: mockRegistry([
          mockOllamaProvider("ollama"),
        ]),
      };

      await expect(
        handleTool("ollama_pull", {}, deps),
      ).rejects.toThrow();
    });
  });

  describe("handleTool dispatcher", () => {
    it("should return error for unknown tool name", async () => {
      const deps: OllamaToolDeps = {
        registry: mockRegistry([]),
      };

      const result = await handleTool("nonexistent_tool", {}, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown tool");
    });
  });
});
