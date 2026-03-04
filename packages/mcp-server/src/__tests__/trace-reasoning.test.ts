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

// ── Mock helpers (same pattern as trace-quality.test.ts) ──────

function mockProvider(id: string, responses: string[]): AIProvider {
  let callIndex = 0;
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
      text: responses[callIndex++] || "no more responses",
      model: "mock-model",
      provider: id,
    }),
  };
}

function mockRegistry(providers: AIProvider[]): ProviderRegistry {
  const map = new Map<string, AIProvider>();
  for (const p of providers) map.set(p.id, p);
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

// ── Tests ────────────────────────────────────────────────────

describe("Semantic tracing — reasoning field", () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let documentManager: DocumentManager;
  let memoryFacade: MemoryFacade;
  let jobMgr: JobManager;
  let traceWriter: TraceWriter;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "trace-reason-test-"));
    sessionManager = new SessionManager(join(tmpDir, "sessions"));
    documentManager = new DocumentManager(join(tmpDir, "workspace"));
    memoryFacade = mockMemoryFacade();
    jobMgr = mockJobManager();
    traceWriter = new TraceWriter(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("agent_assign_task traces include reasoning metadata", async () => {
    const gemini = mockProvider("gemini", ["Review result"]);
    const codex = mockProvider("codex", ["Codex result"]);
    const deps: AgentToolDeps = {
      registry: mockRegistry([gemini, codex]),
      sessionManager,
      memoryFacade,
      jobManager: jobMgr,
      documentManager,
      traceWriter,
    };

    await handleTool("agent_assign_task", {
      provider: "gemini",
      task: "code-review",
      prompt: "Review this",
    }, deps);

    const traces = traceWriter.query({ providerId: "gemini" });
    expect(traces).toHaveLength(1);
    expect(traces[0].reasoning).toBeDefined();
    expect(traces[0].reasoning!.selectedProvider).toBe("gemini");
    expect(traces[0].reasoning!.candidateProviders).toContain("gemini");
    expect(traces[0].reasoning!.candidateProviders).toContain("codex");
    expect(traces[0].reasoning!.selectionReason).toContain("gemini");
  });

  it("agent_debate_turn traces include reasoning metadata", async () => {
    const gemini = mockProvider("gemini", ["Gemini analysis"]);
    const codex = mockProvider("codex", ["Codex analysis"]);
    const deps: AgentToolDeps = {
      registry: mockRegistry([gemini, codex]),
      sessionManager,
      memoryFacade,
      jobManager: jobMgr,
      documentManager,
      traceWriter,
    };

    // Create debate
    const createResult = await handleTool("agent_debate_create", {
      topic: "Test topic",
      providers: ["gemini", "codex"],
      save_document: false,
    }, deps);
    const debateId = createResult.content[0].text.match(/Debate ID:\*\* (\S+)/)![1];

    // Run gemini turn
    await handleTool("agent_debate_turn", {
      debate_id: debateId,
      provider: "gemini",
    }, deps);

    const traces = traceWriter.query({ providerId: "gemini", traceId: debateId });
    expect(traces).toHaveLength(1);
    expect(traces[0].reasoning).toBeDefined();
    expect(traces[0].reasoning!.selectedProvider).toBe("gemini");
    expect(traces[0].reasoning!.candidateProviders).toContain("gemini");
    expect(traces[0].reasoning!.candidateProviders).toContain("codex");
    expect(traces[0].reasoning!.selectionReason).toContain("Debate");
  });

  it("error traces also include reasoning metadata", async () => {
    // Provider that throws
    const failProvider: AIProvider = {
      id: "fail-provider",
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
      chat: async () => {
        throw new Error("Provider crashed");
      },
    };

    const deps: AgentToolDeps = {
      registry: mockRegistry([failProvider]),
      sessionManager,
      memoryFacade,
      jobManager: jobMgr,
      documentManager,
      traceWriter,
    };

    await handleTool("agent_assign_task", {
      provider: "fail-provider",
      task: "test-task",
      prompt: "Do something",
    }, deps);

    const traces = traceWriter.query({ providerId: "fail-provider" });
    expect(traces).toHaveLength(1);
    expect(traces[0].response.success).toBe(false);
    expect(traces[0].reasoning).toBeDefined();
    expect(traces[0].reasoning!.selectedProvider).toBe("fail-provider");
  });
});
