import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleTool, type AgentToolDeps } from "../tools/agent-session.js";
import { SessionManager } from "@agestra/agents";
import { DocumentManager } from "@agestra/workspace";
import { TraceWriter } from "@agestra/core";
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

describe("trace integration", () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let documentManager: DocumentManager;
  let memoryFacade: MemoryFacade;
  let jobMgr: JobManager;
  let traceWriter: TraceWriter;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "trace-integration-test-"));
    sessionManager = new SessionManager(join(tmpDir, "sessions"));
    documentManager = new DocumentManager(join(tmpDir, "workspace"));
    memoryFacade = mockMemoryFacade();
    jobMgr = mockJobManager();
    traceWriter = new TraceWriter(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("agent_assign_task traces", () => {
    it("should record a trace on successful task completion", async () => {
      const deps: AgentToolDeps = {
        registry: mockRegistry([
          mockProvider("gemini", "Task result: feature implemented"),
        ]),
        sessionManager,
        memoryFacade,
        jobManager: jobMgr,
        documentManager,
        traceWriter,
      };

      const result = await handleTool(
        "agent_assign_task",
        { provider: "gemini", task: "Implement feature X", files: ["/src/main.ts"] },
        deps,
      );

      // Verify the tool completed successfully
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("Task completed");

      // Verify trace was written
      const traces = traceWriter.query({ providerId: "gemini" });
      expect(traces).toHaveLength(1);

      const trace = traces[0];
      expect(trace.action).toBe("chat");
      expect(trace.providerId).toBe("gemini");
      expect(trace.task).toBe("Implement feature X");
      expect(trace.response.success).toBe(true);
      expect(trace.response.charLength).toBeGreaterThan(0);
      expect(trace.latencyMs).toBeGreaterThanOrEqual(0);
      expect(trace.request.promptSummary).toContain("Implement feature X");
      expect(trace.request.fileCount).toBe(1);
      expect(trace.traceId).toBeTruthy();
      expect(trace.timestamp).toBeDefined();
    });

    it("should record a trace with success:false on task failure", async () => {
      const failingProvider = mockProvider("failing-provider", "");
      failingProvider.chat = async () => {
        throw new Error("Model overloaded");
      };

      const deps: AgentToolDeps = {
        registry: mockRegistry([failingProvider]),
        sessionManager,
        memoryFacade,
        jobManager: jobMgr,
        documentManager,
        traceWriter,
      };

      const result = await handleTool(
        "agent_assign_task",
        { provider: "failing-provider", task: "Do something" },
        deps,
      );

      // Verify the tool reported the failure
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Task failed");

      // Verify trace was written with failure info
      const traces = traceWriter.query({ providerId: "failing-provider" });
      expect(traces).toHaveLength(1);

      const trace = traces[0];
      expect(trace.action).toBe("chat");
      expect(trace.providerId).toBe("failing-provider");
      expect(trace.task).toBe("Do something");
      expect(trace.response.success).toBe(false);
      expect(trace.response.charLength).toBe(0);
      expect(trace.response.error).toBe("Model overloaded");
      expect(trace.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("should record fileCount of 0 when no files provided", async () => {
      const deps: AgentToolDeps = {
        registry: mockRegistry([mockProvider("ollama", "Done")]),
        sessionManager,
        memoryFacade,
        jobManager: jobMgr,
        documentManager,
        traceWriter,
      };

      await handleTool(
        "agent_assign_task",
        { provider: "ollama", task: "Simple task" },
        deps,
      );

      const traces = traceWriter.query({ providerId: "ollama" });
      expect(traces).toHaveLength(1);
      expect(traces[0].request.fileCount).toBe(0);
    });

    it("should not write traces when traceWriter is undefined", async () => {
      const deps: AgentToolDeps = {
        registry: mockRegistry([
          mockProvider("gemini", "Task result"),
        ]),
        sessionManager,
        memoryFacade,
        jobManager: jobMgr,
        documentManager,
        // traceWriter intentionally omitted
      };

      // Should not throw even without traceWriter
      const result = await handleTool(
        "agent_assign_task",
        { provider: "gemini", task: "Test task" },
        deps,
      );

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("Task completed");

      // traceWriter on deps is undefined, so nothing was written
      // Verify by querying our test traceWriter (which was not passed to deps)
      const traces = traceWriter.query();
      expect(traces).toHaveLength(0);
    });
  });

  describe("agent_debate_turn traces", () => {
    it("should record a trace on debate turn with regular provider", async () => {
      const deps: AgentToolDeps = {
        registry: mockRegistry([
          mockProvider("gemini", "My debate perspective"),
        ]),
        sessionManager,
        memoryFacade,
        jobManager: jobMgr,
        documentManager,
        traceWriter,
      };

      // First create a debate
      const createResult = await handleTool(
        "agent_debate_create",
        { topic: "Best testing approach", providers: ["gemini"], save_document: false },
        deps,
      );
      expect(createResult.isError).toBeUndefined();

      // Extract debate ID from the result
      const debateIdMatch = createResult.content[0].text.match(/\*\*Debate ID:\*\* (.+)/);
      expect(debateIdMatch).toBeTruthy();
      const debateId = debateIdMatch![1];

      // Execute a debate turn
      const turnResult = await handleTool(
        "agent_debate_turn",
        { debate_id: debateId, provider: "gemini" },
        deps,
      );

      expect(turnResult.isError).toBeUndefined();
      expect(turnResult.content[0].text).toContain("gemini");

      // Verify trace was written
      const traces = traceWriter.query({ providerId: "gemini" });
      expect(traces).toHaveLength(1);

      const trace = traces[0];
      expect(trace.action).toBe("debate_turn");
      expect(trace.providerId).toBe("gemini");
      expect(trace.task).toBe("Best testing approach");
      expect(trace.response.success).toBe(true);
      expect(trace.response.charLength).toBeGreaterThan(0);
      expect(trace.latencyMs).toBeGreaterThanOrEqual(0);
      expect(trace.traceId).toBe(debateId);
    });

    it("should NOT record a trace for Claude turns", async () => {
      const deps: AgentToolDeps = {
        registry: mockRegistry([
          mockProvider("gemini", "perspective"),
        ]),
        sessionManager,
        memoryFacade,
        jobManager: jobMgr,
        documentManager,
        traceWriter,
      };

      // Create a debate
      const createResult = await handleTool(
        "agent_debate_create",
        { topic: "Test topic", providers: ["gemini", "claude"], save_document: false },
        deps,
      );
      const debateIdMatch = createResult.content[0].text.match(/\*\*Debate ID:\*\* (.+)/);
      const debateId = debateIdMatch![1];

      // Execute Claude's turn (no external provider call, no trace)
      await handleTool(
        "agent_debate_turn",
        { debate_id: debateId, provider: "claude", claude_comment: "My opinion" },
        deps,
      );

      // No traces should have been recorded (Claude is not a provider)
      const traces = traceWriter.query();
      expect(traces).toHaveLength(0);
    });
  });

  describe("trace traceId linkage", () => {
    it("should use session.id as traceId for task assignments", async () => {
      const deps: AgentToolDeps = {
        registry: mockRegistry([mockProvider("ollama", "Result")]),
        sessionManager,
        memoryFacade,
        jobManager: jobMgr,
        documentManager,
        traceWriter,
      };

      await handleTool(
        "agent_assign_task",
        { provider: "ollama", task: "Test" },
        deps,
      );

      // Get session ID
      const sessions = sessionManager.listSessions();
      expect(sessions).toHaveLength(1);
      const sessionId = sessions[0].id;

      // Trace traceId should match the session ID
      const traces = traceWriter.query();
      expect(traces).toHaveLength(1);
      expect(traces[0].traceId).toBe(sessionId);
    });
  });
});
