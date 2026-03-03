import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTools, handleTool, type ToolDeps } from "../tools/ai-chat.js";
import type {
  AIProvider,
  ChatRequest,
  ChatResponse,
  ProviderCapability,
  HealthStatus,
  ProviderRegistry,
} from "@agestra/core";
import { readFileSync, writeFileSync, renameSync } from "fs";

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

// ── Mock helpers ─────────────────────────────────────────────

function mockProvider(id: string, response: string): AIProvider {
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
      strengths: [],
      models: [],
    }),
    isAvailable: () => true,
    chat: async (_req: ChatRequest): Promise<ChatResponse> => ({
      text: response,
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

describe("ai-chat tools", () => {
  describe("getTools", () => {
    it("should return 3 tool definitions", () => {
      const tools = getTools();
      expect(tools).toHaveLength(3);
      const names = tools.map((t) => t.name);
      expect(names).toContain("ai_chat");
      expect(names).toContain("ai_analyze_files");
      expect(names).toContain("ai_compare");
    });

    it("should have valid inputSchema for each tool", () => {
      const tools = getTools();
      for (const tool of tools) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe("object");
        expect(tool.inputSchema.required).toBeDefined();
        expect(tool.description).toBeTruthy();
      }
    });
  });

  describe("ai_chat", () => {
    let deps: ToolDeps;

    beforeEach(() => {
      deps = { registry: mockRegistry([mockProvider("gemini", "Hello from Gemini!")]) };
    });

    it("should chat with a provider and return formatted response", async () => {
      const result = await handleTool(
        "ai_chat",
        { provider: "gemini", prompt: "Hello" },
        deps,
      );

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain("Hello from Gemini!");
      expect(result.content[0].text).toContain("gemini");
      expect(result.content[0].text).toContain("mock-model");
    });

    it("should pass model and system to the provider", async () => {
      const chatSpy = vi.fn().mockResolvedValue({
        text: "response",
        model: "custom-model",
        provider: "gemini",
      });
      const provider = mockProvider("gemini", "");
      provider.chat = chatSpy;
      deps = { registry: mockRegistry([provider]) };

      await handleTool(
        "ai_chat",
        { provider: "gemini", prompt: "Hello", model: "custom-model", system: "Be helpful" },
        deps,
      );

      expect(chatSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "Hello",
          model: "custom-model",
          system: "Be helpful",
        }),
      );
    });

    it("should pass file references when files provided", async () => {
      const chatSpy = vi.fn().mockResolvedValue({
        text: "response",
        model: "mock",
        provider: "gemini",
      });
      const provider = mockProvider("gemini", "");
      provider.chat = chatSpy;
      deps = { registry: mockRegistry([provider]) };

      await handleTool(
        "ai_chat",
        { provider: "gemini", prompt: "Analyze", files: ["/path/a.ts", "/path/b.ts"] },
        deps,
      );

      expect(chatSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          files: [{ path: "/path/a.ts" }, { path: "/path/b.ts" }],
        }),
      );
    });

    it("should throw for unknown provider", async () => {
      await expect(
        handleTool("ai_chat", { provider: "unknown", prompt: "hi" }, deps),
      ).rejects.toThrow("Provider not found");
    });

    it("should throw for missing required fields", async () => {
      await expect(
        handleTool("ai_chat", { provider: "gemini" }, deps),
      ).rejects.toThrow();
    });
  });

  describe("ai_analyze_files", () => {
    let deps: ToolDeps;
    let chatSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      vi.clearAllMocks();

      chatSpy = vi.fn().mockResolvedValue({
        text: "Analysis result: looks good!",
        model: "mock-model",
        provider: "gemini",
      });
      const provider = mockProvider("gemini", "");
      provider.chat = chatSpy;
      deps = { registry: mockRegistry([provider]) };

      vi.mocked(readFileSync).mockImplementation((path: any) => {
        if (String(path) === "/project/src/main.ts") return 'console.log("hello");';
        if (String(path) === "/project/src/util.ts") return "export function add(a: number, b: number) { return a + b; }";
        throw new Error(`File not found: ${path}`);
      });
    });

    it("should read files and send combined prompt to provider", async () => {
      const result = await handleTool(
        "ai_analyze_files",
        {
          provider: "gemini",
          file_paths: ["/project/src/main.ts"],
          question: "What does this code do?",
        },
        deps,
      );

      expect(readFileSync).toHaveBeenCalledWith("/project/src/main.ts", "utf-8");
      expect(chatSpy).toHaveBeenCalledTimes(1);
      const promptArg = chatSpy.mock.calls[0][0].prompt;
      expect(promptArg).toContain('/project/src/main.ts');
      expect(promptArg).toContain('console.log("hello")');
      expect(promptArg).toContain("What does this code do?");

      expect(result.content[0].text).toContain("Analysis result: looks good!");
      expect(result.content[0].text).toContain("/project/src/main.ts");
    });

    it("should handle multiple files", async () => {
      await handleTool(
        "ai_analyze_files",
        {
          provider: "gemini",
          file_paths: ["/project/src/main.ts", "/project/src/util.ts"],
          question: "Compare these files",
        },
        deps,
      );

      expect(readFileSync).toHaveBeenCalledTimes(2);
      const promptArg = chatSpy.mock.calls[0][0].prompt;
      expect(promptArg).toContain("/project/src/main.ts");
      expect(promptArg).toContain("/project/src/util.ts");
      expect(promptArg).toContain("Compare these files");
    });

    it("should save result to file when save_to_file is provided", async () => {
      const result = await handleTool(
        "ai_analyze_files",
        {
          provider: "gemini",
          file_paths: ["/project/src/main.ts"],
          question: "Review this",
          save_to_file: "/output/analysis.md",
        },
        deps,
      );

      // atomicWriteSync writes to a temp file then renames to the target
      expect(writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining(".tmp-"),
        "Analysis result: looks good!",
        "utf-8",
      );
      expect(renameSync).toHaveBeenCalledWith(
        expect.stringContaining(".tmp-"),
        "/output/analysis.md",
      );
      expect(result.content[0].text).toContain("/output/analysis.md");
    });

    it("should throw for empty file_paths", async () => {
      await expect(
        handleTool(
          "ai_analyze_files",
          { provider: "gemini", file_paths: [], question: "test" },
          deps,
        ),
      ).rejects.toThrow();
    });
  });

  describe("ai_compare", () => {
    let deps: ToolDeps;

    beforeEach(() => {
      deps = {
        registry: mockRegistry([
          mockProvider("gemini", "Gemini says: TypeScript is great"),
          mockProvider("ollama", "Ollama says: TypeScript has benefits"),
          mockProvider("codex", "Codex says: TypeScript improves safety"),
        ]),
      };
    });

    it("should send prompt to all providers in parallel and return comparison", async () => {
      const result = await handleTool(
        "ai_compare",
        {
          providers: ["gemini", "ollama", "codex"],
          prompt: "What do you think of TypeScript?",
        },
        deps,
      );

      expect(result.content).toHaveLength(1);
      const text = result.content[0].text;
      expect(text).toContain("gemini");
      expect(text).toContain("ollama");
      expect(text).toContain("codex");
      expect(text).toContain("Gemini says: TypeScript is great");
      expect(text).toContain("Ollama says: TypeScript has benefits");
      expect(text).toContain("Codex says: TypeScript improves safety");
      expect(text).toContain("What do you think of TypeScript?");
    });

    it("should handle provider errors gracefully in comparison", async () => {
      const failingProvider = mockProvider("failing", "");
      failingProvider.chat = async () => {
        throw new Error("Connection refused");
      };
      deps = {
        registry: mockRegistry([
          mockProvider("gemini", "Works fine"),
          failingProvider,
        ]),
      };

      const result = await handleTool(
        "ai_compare",
        { providers: ["gemini", "failing"], prompt: "test" },
        deps,
      );

      const text = result.content[0].text;
      expect(text).toContain("Works fine");
      expect(text).toContain("Connection refused");
      expect(text).toContain("Error");
    });

    it("should throw when provider does not exist", async () => {
      await expect(
        handleTool(
          "ai_compare",
          { providers: ["nonexistent"], prompt: "test" },
          deps,
        ),
      ).rejects.toThrow("Provider not found");
    });

    it("should throw for empty providers array", async () => {
      await expect(
        handleTool("ai_compare", { providers: [], prompt: "test" }, deps),
      ).rejects.toThrow();
    });
  });

  describe("handleTool dispatcher", () => {
    it("should return error for unknown tool name", async () => {
      const deps = { registry: mockRegistry([]) };
      const result = await handleTool("nonexistent_tool", {}, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown tool");
    });
  });
});
