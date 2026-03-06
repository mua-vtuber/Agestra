import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  collectTools,
  dispatch,
  truncateResponse,
  type ServerDependencies,
} from "../server.js";
import type {
  AIProvider,
  ChatRequest,
  ChatResponse,
  ProviderCapability,
  HealthStatus,
  ProviderRegistry,
} from "@agestra/core";
import type { SessionManager } from "@agestra/agents";
import type { DocumentManager } from "@agestra/workspace";
import type { MemoryFacade } from "@agestra/memory";
import type { JobManager } from "@agestra/core";

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

function mockSessionManager(): SessionManager {
  return {
    createSession: vi.fn().mockReturnValue({
      id: "session-1",
      type: "task",
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      config: {},
    }),
    getSession: vi.fn(),
    updateSessionStatus: vi.fn(),
    completeSession: vi.fn(),
    listSessions: vi.fn().mockReturnValue([]),
  } as unknown as SessionManager;
}

function mockDocumentManager(): DocumentManager {
  return {
    createReview: vi.fn().mockResolvedValue({
      id: "doc-1",
      path: "/workspace/reviews/doc-1.md",
      content: "Review content",
    }),
    read: vi.fn().mockResolvedValue({
      id: "doc-1",
      path: "/workspace/reviews/doc-1.md",
      content: "Review content",
    }),
    addComment: vi.fn(),
  } as unknown as DocumentManager;
}

function mockMemoryFacade(): MemoryFacade {
  return {
    isInitialized: true,
    search: vi.fn().mockResolvedValue([]),
    store: vi.fn(),
    getAssembledContext: vi.fn(),
    addEdge: vi.fn(),
  } as unknown as MemoryFacade;
}

function mockJobMgr(): JobManager {
  return {
    submit: vi.fn().mockReturnValue("mock-job-id"),
    getStatus: vi.fn().mockReturnValue(null),
    getResult: vi.fn().mockReturnValue(null),
    listJobs: vi.fn().mockReturnValue([]),
    cancel: vi.fn().mockReturnValue(false),
  } as unknown as JobManager;
}

function createDeps(
  overrides: Partial<ServerDependencies> = {},
): ServerDependencies {
  return {
    registry: mockRegistry([
      mockProvider("ollama", "Ollama response"),
      mockProvider("gemini", "Gemini response"),
    ]),
    sessionManager: mockSessionManager(),
    documentManager: mockDocumentManager(),
    memoryFacade: mockMemoryFacade(),
    jobManager: mockJobMgr(),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe("server", () => {
  describe("collectTools", () => {
    it("should return exactly 39 tool definitions", () => {
      const tools = collectTools();
      expect(tools).toHaveLength(39);
    });

    it("should have unique tool names", () => {
      const tools = collectTools();
      const names = tools.map((t) => t.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(names.length);
    });

    it("should include all expected tool names", () => {
      const tools = collectTools();
      const names = tools.map((t) => t.name);

      // ai-chat tools (3)
      expect(names).toContain("ai_chat");
      expect(names).toContain("ai_analyze_files");
      expect(names).toContain("ai_compare");

      // agent-session tools (6)
      expect(names).toContain("agent_debate_start");
      expect(names).toContain("agent_debate_status");
      expect(names).toContain("agent_assign_task");
      expect(names).toContain("agent_task_status");
      expect(names).toContain("agent_dispatch");
      expect(names).toContain("agent_cross_validate");

      // workspace tools (4)
      expect(names).toContain("workspace_create_review");
      expect(names).toContain("workspace_request_review");
      expect(names).toContain("workspace_add_comment");
      expect(names).toContain("workspace_read");

      // provider-manage tools (2)
      expect(names).toContain("provider_list");
      expect(names).toContain("provider_health");

      // ollama-manage tools (2)
      expect(names).toContain("ollama_models");
      expect(names).toContain("ollama_pull");

      // memory tools (6)
      expect(names).toContain("memory_search");
      expect(names).toContain("memory_index");
      expect(names).toContain("memory_store");
      expect(names).toContain("memory_dead_ends");
      expect(names).toContain("memory_context");
      expect(names).toContain("memory_add_edge");

      // jobs tools (2)
      expect(names).toContain("cli_job_submit");
      expect(names).toContain("cli_job_status");

      // trace tools (3)
      expect(names).toContain("trace_query");
      expect(names).toContain("trace_summary");
      expect(names).toContain("trace_visualize");
    });

    it("should have valid inputSchema for each tool", () => {
      const tools = collectTools();
      for (const tool of tools) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.description).toBeTruthy();
        expect(tool.name).toBeTruthy();
      }
    });
  });

  describe("dispatch", () => {
    let deps: ServerDependencies;

    beforeEach(() => {
      deps = createDeps();
    });

    it("should dispatch ai_chat to the ai-chat handler", async () => {
      const result = await dispatch(
        "ai_chat",
        { provider: "gemini", prompt: "Hello" },
        deps,
      );

      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].text).toContain("Gemini response");
      expect(result.content[0].text).toContain("gemini");
    });

    it("should dispatch provider_list to the provider-manage handler", async () => {
      const result = await dispatch("provider_list", {}, deps);

      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].text).toContain("Registered Providers");
      expect(result.content[0].text).toContain("ollama");
      expect(result.content[0].text).toContain("gemini");
    });

    it("should dispatch memory_search to the memory handler", async () => {
      const result = await dispatch(
        "memory_search",
        { query: "test query" },
        deps,
      );

      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].text).toContain("test query");
    });

    it("should dispatch workspace_read to the workspace handler", async () => {
      const result = await dispatch(
        "workspace_read",
        { doc_id: "doc-1" },
        deps,
      );

      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].text).toContain("doc-1");
    });

    it("should return error for unknown tool", async () => {
      const result = await dispatch("nonexistent_tool", {}, deps);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown tool");
      expect(result.content[0].text).toContain("nonexistent_tool");
    });

    it("should apply response truncation on large responses", async () => {
      // Create a provider that returns a huge response
      const hugeText = "x".repeat(60 * 1024); // 60KB
      const bigProvider = mockProvider("big", hugeText);
      const bigDeps = createDeps({
        registry: mockRegistry([bigProvider]),
      });

      const result = await dispatch(
        "ai_chat",
        { provider: "big", prompt: "Generate big" },
        bigDeps,
      );

      const responseText = result.content[0].text;
      // The response should be truncated: the total byte length should be
      // well under 60KB and should contain the truncation marker
      expect(Buffer.byteLength(responseText, "utf-8")).toBeLessThan(55 * 1024);
      expect(responseText).toContain("[Response truncated at 50KB]");
    });
  });

  describe("truncateResponse", () => {
    it("should pass through small responses unchanged", () => {
      const input = {
        content: [{ type: "text" as const, text: "Small response" }],
      };
      const result = truncateResponse(input);
      expect(result.content[0].text).toBe("Small response");
    });

    it("should truncate responses exceeding 50KB", () => {
      const bigText = "A".repeat(60 * 1024); // 60KB
      const input = {
        content: [{ type: "text" as const, text: bigText }],
      };
      const result = truncateResponse(input);

      expect(result.content[0].text).toContain("[Response truncated at 50KB]");
      // Truncated portion should be roughly 50KB
      expect(Buffer.byteLength(result.content[0].text, "utf-8")).toBeLessThan(
        55 * 1024,
      );
    });

    it("should preserve isError flag", () => {
      const input = {
        content: [{ type: "text" as const, text: "Error message" }],
        isError: true,
      };
      const result = truncateResponse(input);
      expect(result.isError).toBe(true);
    });

    it("should handle multiple content items", () => {
      const bigText = "B".repeat(60 * 1024);
      const input = {
        content: [
          { type: "text" as const, text: "Small" },
          { type: "text" as const, text: bigText },
        ],
      };
      const result = truncateResponse(input);

      expect(result.content[0].text).toBe("Small");
      expect(result.content[1].text).toContain("[Response truncated at 50KB]");
    });
  });
});
