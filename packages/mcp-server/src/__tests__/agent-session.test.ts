import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getTools, handleTool, type AgentToolDeps } from "../tools/agent-session.js";
import { SessionManager } from "@agestra/agents";
import { DocumentManager } from "@agestra/workspace";
import type {
  AIProvider,
  ChatRequest,
  ChatResponse,
  ProviderCapability,
  HealthStatus,
  ProviderRegistry,
  JobManager,
} from "@agestra/core";
import type { MemoryFacade } from "@agestra/memory";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

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

function mockMemoryFacade(): MemoryFacade {
  return {
    isInitialized: true,
    initialize: vi.fn(),
    close: vi.fn(),
    store: vi.fn().mockReturnValue("mock-node-id"),
    search: vi.fn().mockResolvedValue([]),
    getNode: vi.fn(),
    getPinnedNodes: vi.fn().mockReturnValue([]),
    getAssembledContext: vi.fn(),
    extractAndStore: vi.fn(),
    evolve: vi.fn(),
    shouldReflect: vi.fn().mockReturnValue(false),
    reflect: vi.fn(),
    pinMessage: vi.fn(),
    deleteNode: vi.fn(),
    embedUnembeddedNodes: vi.fn(),
    getDatabase: vi.fn(),
    addEdge: vi.fn().mockReturnValue("mock-edge-id"),
  } as unknown as MemoryFacade;
}

function mockJobManager(): JobManager {
  return {
    submit: vi.fn().mockReturnValue("mock-job-id"),
    getStatus: vi.fn().mockReturnValue(null),
    getResult: vi.fn().mockReturnValue(null),
    listJobs: vi.fn().mockReturnValue([]),
    cancel: vi.fn().mockReturnValue(false),
  } as unknown as JobManager;
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

describe("agent-session tools", () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let documentManager: DocumentManager;
  let memoryFacade: MemoryFacade;
  let jobMgr: JobManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-session-test-"));
    sessionManager = new SessionManager(tmpDir);
    documentManager = new DocumentManager(tmpDir);
    memoryFacade = mockMemoryFacade();
    jobMgr = mockJobManager();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("getTools", () => {
    it("should return 9 tool definitions", () => {
      const tools = getTools();
      expect(tools).toHaveLength(9);
      const names = tools.map((t) => t.name);
      expect(names).toContain("agent_debate_start");
      expect(names).toContain("agent_debate_status");
      expect(names).toContain("agent_assign_task");
      expect(names).toContain("agent_task_status");
      expect(names).toContain("agent_dispatch");
      expect(names).toContain("agent_cross_validate");
      expect(names).toContain("agent_debate_create");
      expect(names).toContain("agent_debate_turn");
      expect(names).toContain("agent_debate_conclude");
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

  describe("agent_debate_start (non-blocking)", () => {
    it("should return Debate started with session ID", async () => {
      const deps: AgentToolDeps = {
        registry: mockRegistry([
          mockProvider("gemini", "Gemini's perspective"),
          mockProvider("ollama", "Ollama's perspective"),
        ]),
        sessionManager,
        memoryFacade,
        jobManager: jobMgr,
        documentManager,
      };

      const result = await handleTool(
        "agent_debate_start",
        {
          topic: "Best framework for web apps",
          providers: ["gemini", "ollama"],
          max_rounds: 1,
        },
        deps,
      );

      expect(result.content).toHaveLength(1);
      const text = result.content[0].text;
      // Non-blocking: returns with session info
      expect(text).toContain("Debate started");
      expect(text).toContain("Best framework for web apps");
      expect(text).toContain("gemini");
      expect(text).toContain("ollama");

      // Session created (with instant mocks, async .then() settles on microtask queue
      // so session may already be completed by the time we check)
      const sessions = sessionManager.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].type).toBe("debate");
    });

    it("should not block on debate execution", async () => {
      let callCount = 0;
      const provider = mockProvider("gemini", "");
      provider.chat = async () => {
        callCount++;
        return { text: `Round response ${callCount}`, model: "mock", provider: "gemini" };
      };

      const deps: AgentToolDeps = {
        registry: mockRegistry([provider]),
        sessionManager,
        memoryFacade,
        jobManager: jobMgr,
        documentManager,
      };

      const result = await handleTool(
        "agent_debate_start",
        { topic: "test", providers: ["gemini"] },
        deps,
      );

      // Returns with session ID — debate runs in background
      expect(result.content[0].text).toContain("Debate started");
    });

    it("should return success response even when debate will fail", async () => {
      const failingProvider = mockProvider("failing", "");
      failingProvider.chat = async () => {
        throw new Error("Provider crashed");
      };

      const deps: AgentToolDeps = {
        registry: mockRegistry([failingProvider]),
        sessionManager,
        memoryFacade,
        jobManager: jobMgr,
        documentManager,
      };

      const result = await handleTool(
        "agent_debate_start",
        { topic: "test", providers: ["failing"], max_rounds: 1 },
        deps,
      );

      // Non-blocking: handler returns success; failure handled by async .catch()
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("Debate started");

      // Flush microtask queue so fire-and-forget .catch() settles
      await new Promise((r) => setTimeout(r, 0));

      const sessions = sessionManager.listSessions();
      expect(sessions[0].status).toBe("failed");
    });

    it("should throw for unknown provider (synchronous validation)", async () => {
      const deps: AgentToolDeps = {
        registry: mockRegistry([]),
        sessionManager,
        memoryFacade,
        jobManager: jobMgr,
        documentManager,
      };

      await expect(
        handleTool(
          "agent_debate_start",
          { topic: "test", providers: ["nonexistent"], max_rounds: 1 },
          deps,
        ),
      ).rejects.toThrow("Provider not found");
    });

    it("should throw for empty providers array", async () => {
      const deps: AgentToolDeps = {
        registry: mockRegistry([]),
        sessionManager,
        memoryFacade,
        jobManager: jobMgr,
        documentManager,
      };

      await expect(
        handleTool(
          "agent_debate_start",
          { topic: "test", providers: [] },
          deps,
        ),
      ).rejects.toThrow();
    });
  });

  describe("agent_debate_status", () => {
    it("should return session status for debate", async () => {
      const deps: AgentToolDeps = {
        registry: mockRegistry([mockProvider("gemini", "My take")]),
        sessionManager,
        memoryFacade,
        jobManager: jobMgr,
        documentManager,
      };

      // Start a debate (non-blocking)
      await handleTool(
        "agent_debate_start",
        { topic: "test topic", providers: ["gemini"], max_rounds: 1 },
        deps,
      );

      // Flush microtask queue so fire-and-forget .then() settles
      await new Promise((r) => setTimeout(r, 0));

      const sessionId = sessionManager.listSessions()[0].id;

      const statusResult = await handleTool(
        "agent_debate_status",
        { session_id: sessionId },
        deps,
      );

      const text = statusResult.content[0].text;
      expect(text).toContain(sessionId);
      expect(text).toContain("completed");
      expect(text).toContain("debate");
      expect(text).toContain("test topic");
    });

    it("should return error for nonexistent session", async () => {
      const deps: AgentToolDeps = {
        registry: mockRegistry([]),
        sessionManager,
        memoryFacade,
        jobManager: jobMgr,
        documentManager,
      };

      const result = await handleTool(
        "agent_debate_status",
        { session_id: "nonexistent" },
        deps,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Session not found");
    });
  });

  describe("agent_assign_task", () => {
    it("should assign and complete a task", async () => {
      const deps: AgentToolDeps = {
        registry: mockRegistry([
          mockProvider("gemini", "Task completed successfully: implemented feature X"),
        ]),
        sessionManager,
        memoryFacade,
        jobManager: jobMgr,
        documentManager,
      };

      const result = await handleTool(
        "agent_assign_task",
        { provider: "gemini", task: "Implement feature X" },
        deps,
      );

      expect(result.content).toHaveLength(1);
      const text = result.content[0].text;
      expect(text).toContain("Task completed");
      expect(text).toContain("gemini");
      expect(text).toContain("implemented feature X");

      // Check session
      const sessions = sessionManager.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].type).toBe("task");
      expect(sessions[0].status).toBe("completed");
    });

    it("should include file context in prompt", async () => {
      const chatSpy = vi.fn().mockResolvedValue({
        text: "Done",
        model: "mock",
        provider: "gemini",
      });
      const provider = mockProvider("gemini", "");
      provider.chat = chatSpy;

      const deps: AgentToolDeps = {
        registry: mockRegistry([provider]),
        sessionManager,
        memoryFacade,
        jobManager: jobMgr,
        documentManager,
      };

      await handleTool(
        "agent_assign_task",
        {
          provider: "gemini",
          task: "Review code",
          files: ["/src/main.ts", "/src/util.ts"],
        },
        deps,
      );

      const prompt = chatSpy.mock.calls[0][0].prompt;
      expect(prompt).toContain("Review code");
      expect(prompt).toContain("/src/main.ts");
      expect(prompt).toContain("/src/util.ts");
    });

    it("should handle task failure gracefully", async () => {
      const failingProvider = mockProvider("failing", "");
      failingProvider.chat = async () => {
        throw new Error("Model overloaded");
      };

      const deps: AgentToolDeps = {
        registry: mockRegistry([failingProvider]),
        sessionManager,
        memoryFacade,
        jobManager: jobMgr,
        documentManager,
      };

      const result = await handleTool(
        "agent_assign_task",
        { provider: "failing", task: "Do something" },
        deps,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Task failed");
      expect(result.content[0].text).toContain("Model overloaded");

      const sessions = sessionManager.listSessions();
      expect(sessions[0].status).toBe("failed");
    });

    it("should throw for unknown provider", async () => {
      const deps: AgentToolDeps = {
        registry: mockRegistry([]),
        sessionManager,
        memoryFacade,
        jobManager: jobMgr,
        documentManager,
      };

      await expect(
        handleTool(
          "agent_assign_task",
          { provider: "unknown", task: "test" },
          deps,
        ),
      ).rejects.toThrow("Provider not found");
    });
  });

  describe("agent_task_status", () => {
    it("should return task status for completed task", async () => {
      const deps: AgentToolDeps = {
        registry: mockRegistry([mockProvider("gemini", "Task result here")]),
        sessionManager,
        memoryFacade,
        jobManager: jobMgr,
        documentManager,
      };

      // Assign a task first
      await handleTool(
        "agent_assign_task",
        { provider: "gemini", task: "Write tests" },
        deps,
      );

      const taskId = sessionManager.listSessions()[0].id;

      const statusResult = await handleTool(
        "agent_task_status",
        { task_id: taskId },
        deps,
      );

      const text = statusResult.content[0].text;
      expect(text).toContain(taskId);
      expect(text).toContain("completed");
      expect(text).toContain("gemini");
      expect(text).toContain("Write tests");
      expect(text).toContain("Task result here");
    });

    it("should return error for nonexistent task", async () => {
      const deps: AgentToolDeps = {
        registry: mockRegistry([]),
        sessionManager,
        memoryFacade,
        jobManager: jobMgr,
        documentManager,
      };

      const result = await handleTool(
        "agent_task_status",
        { task_id: "nonexistent" },
        deps,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Task not found");
    });

    it("should return failed status for failed task", async () => {
      const failingProvider = mockProvider("failing", "");
      failingProvider.chat = async () => {
        throw new Error("fail");
      };

      const deps: AgentToolDeps = {
        registry: mockRegistry([failingProvider]),
        sessionManager,
        memoryFacade,
        jobManager: jobMgr,
        documentManager,
      };

      // This will fail
      await handleTool(
        "agent_assign_task",
        { provider: "failing", task: "test" },
        deps,
      );

      const taskId = sessionManager.listSessions()[0].id;
      const statusResult = await handleTool(
        "agent_task_status",
        { task_id: taskId },
        deps,
      );

      expect(statusResult.content[0].text).toContain("failed");
    });
  });

  describe("handleTool dispatcher", () => {
    it("should return error for unknown tool name", async () => {
      const deps: AgentToolDeps = {
        registry: mockRegistry([]),
        sessionManager,
        memoryFacade,
        jobManager: jobMgr,
        documentManager,
      };

      const result = await handleTool("nonexistent_tool", {}, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown tool");
    });
  });
});
