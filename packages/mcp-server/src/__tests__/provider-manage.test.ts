import { describe, it, expect, vi } from "vitest";
import { getTools, handleTool, type ProviderManageToolDeps } from "../tools/provider-manage.js";
import type {
  AIProvider,
  ChatRequest,
  ChatResponse,
  ProviderCapability,
  HealthStatus,
  ProviderRegistry,
} from "@agestra/core";

// ── Mock helpers ─────────────────────────────────────────────

function mockProvider(
  id: string,
  opts?: {
    type?: string;
    available?: boolean;
    healthStatus?: HealthStatus;
    strengths?: string[];
    models?: Array<{ name: string; description: string; strengths: string[] }>;
  },
): AIProvider {
  const o = opts || {};
  return {
    id,
    type: o.type || "mock",
    initialize: async () => {},
    healthCheck: async (): Promise<HealthStatus> =>
      o.healthStatus || { status: "ok", message: "All good" },
    getCapabilities: (): ProviderCapability => ({
      maxContext: 4096,
      supportsSystemPrompt: true,
      supportsFiles: false,
      supportsStreaming: false,
      supportsJsonOutput: false,
      supportsToolUse: false,
      strengths: o.strengths || [],
      models: o.models || [],
    }),
    isAvailable: () => o.available !== undefined ? o.available : true,
    chat: async (_req: ChatRequest): Promise<ChatResponse> => ({
      text: "response",
      model: "mock-model",
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

describe("provider-manage tools", () => {
  describe("getTools", () => {
    it("should return 2 tool definitions", () => {
      const tools = getTools();
      expect(tools).toHaveLength(2);
      const names = tools.map((t) => t.name);
      expect(names).toContain("provider_list");
      expect(names).toContain("provider_health");
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

  describe("provider_list", () => {
    it("should list all registered providers with capabilities", async () => {
      const deps: ProviderManageToolDeps = {
        registry: mockRegistry([
          mockProvider("gemini", {
            type: "gemini-cli",
            strengths: ["code_review", "analysis"],
            models: [{ name: "gemini-2.5-pro", description: "Pro model", strengths: ["analysis"] }],
          }),
          mockProvider("ollama", {
            type: "ollama",
            available: false,
          }),
        ]),
      };

      const result = await handleTool("provider_list", {}, deps);

      const text = result.content[0].text;
      expect(text).toContain("Registered Providers (2)");
      expect(text).toContain("gemini");
      expect(text).toContain("gemini-cli");
      expect(text).toContain("Available");
      expect(text).toContain("code_review, analysis");
      expect(text).toContain("gemini-2.5-pro");
      expect(text).toContain("ollama");
      expect(text).toContain("Unavailable");
    });

    it("should return message when no providers registered", async () => {
      const deps: ProviderManageToolDeps = {
        registry: mockRegistry([]),
      };

      const result = await handleTool("provider_list", {}, deps);
      expect(result.content[0].text).toContain("No providers registered");
    });
  });

  describe("provider_health", () => {
    it("should check health of a specific provider", async () => {
      const deps: ProviderManageToolDeps = {
        registry: mockRegistry([
          mockProvider("gemini", {
            healthStatus: { status: "ok", message: "3 models available" },
          }),
        ]),
      };

      const result = await handleTool(
        "provider_health",
        { provider: "gemini" },
        deps,
      );

      const text = result.content[0].text;
      expect(text).toContain("gemini");
      expect(text).toContain("OK");
      expect(text).toContain("3 models available");
    });

    it("should check all providers when no provider specified", async () => {
      const deps: ProviderManageToolDeps = {
        registry: mockRegistry([
          mockProvider("gemini", {
            healthStatus: { status: "ok", message: "Healthy" },
          }),
          mockProvider("ollama", {
            healthStatus: { status: "degraded", message: "No models" },
          }),
        ]),
      };

      const result = await handleTool("provider_health", {}, deps);

      const text = result.content[0].text;
      expect(text).toContain("gemini");
      expect(text).toContain("OK");
      expect(text).toContain("ollama");
      expect(text).toContain("DEGRADED");
      expect(text).toContain("No models");
    });

    it("should handle health check errors gracefully", async () => {
      const failingProvider = mockProvider("failing");
      failingProvider.healthCheck = async () => {
        throw new Error("Connection refused");
      };

      const deps: ProviderManageToolDeps = {
        registry: mockRegistry([failingProvider]),
      };

      const result = await handleTool(
        "provider_health",
        { provider: "failing" },
        deps,
      );

      const text = result.content[0].text;
      expect(text).toContain("failing");
      expect(text).toContain("ERROR");
      expect(text).toContain("Connection refused");
    });

    it("should throw when specified provider does not exist", async () => {
      const deps: ProviderManageToolDeps = {
        registry: mockRegistry([]),
      };

      await expect(
        handleTool("provider_health", { provider: "nonexistent" }, deps),
      ).rejects.toThrow("Provider not found");
    });

    it("should return message when no providers to check", async () => {
      const deps: ProviderManageToolDeps = {
        registry: mockRegistry([]),
      };

      const result = await handleTool("provider_health", {}, deps);
      expect(result.content[0].text).toContain("No providers to check");
    });
  });

  describe("handleTool dispatcher", () => {
    it("should return error for unknown tool name", async () => {
      const deps: ProviderManageToolDeps = {
        registry: mockRegistry([]),
      };

      const result = await handleTool("nonexistent_tool", {}, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown tool");
    });
  });
});
