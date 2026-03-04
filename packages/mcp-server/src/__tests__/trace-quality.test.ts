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

describe("trace quality scoring in debate conclude", () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let documentManager: DocumentManager;
  let memoryFacade: MemoryFacade;
  let jobMgr: JobManager;
  let traceWriter: TraceWriter;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "trace-quality-test-"));
    sessionManager = new SessionManager(join(tmpDir, "sessions"));
    documentManager = new DocumentManager(join(tmpDir, "workspace"));
    memoryFacade = mockMemoryFacade();
    jobMgr = mockJobManager();
    traceWriter = new TraceWriter(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Helper: create a debate, run provider turns, return the debate ID */
  async function createDebateWithTurns(
    deps: AgentToolDeps,
    providerIds: string[],
  ): Promise<string> {
    const createResult = await handleTool(
      "agent_debate_create",
      { topic: "Test debate", providers: providerIds, save_document: false },
      deps,
    );
    const debateId = createResult.content[0].text.match(/Debate ID:\*\* (\S+)/)![1];

    for (const pid of providerIds) {
      await handleTool(
        "agent_debate_turn",
        { debate_id: debateId, provider: pid },
        deps,
      );
    }

    return debateId;
  }

  // ── Test 1: quality_scores in debate conclude writes quality updates to trace ──

  it("should write quality updates to trace when quality_scores is provided", async () => {
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

    const debateId = await createDebateWithTurns(deps, ["gemini", "codex"]);

    // Conclude with quality scores
    const concludeResult = await handleTool(
      "agent_debate_conclude",
      {
        debate_id: debateId,
        summary: "Both provided valuable insights",
        quality_scores: [
          { provider: "gemini", score: 0.85, feedback: "Thorough analysis with good examples" },
          { provider: "codex", score: 0.72, feedback: "Good but could be more detailed" },
        ],
      },
      deps,
    );

    expect(concludeResult.isError).toBeUndefined();
    expect(concludeResult.content[0].text).toContain("Debate concluded");

    // Query traces for gemini — should have quality merged in
    const geminiTraces = traceWriter.query({ providerId: "gemini", traceId: debateId });
    expect(geminiTraces).toHaveLength(1);
    expect(geminiTraces[0].quality).toBeDefined();
    expect(geminiTraces[0].quality!.score).toBe(0.85);
    expect(geminiTraces[0].quality!.evaluator).toBe("claude");
    expect(geminiTraces[0].quality!.feedback).toBe("Thorough analysis with good examples");

    // Query traces for codex — should have quality merged in
    const codexTraces = traceWriter.query({ providerId: "codex", traceId: debateId });
    expect(codexTraces).toHaveLength(1);
    expect(codexTraces[0].quality).toBeDefined();
    expect(codexTraces[0].quality!.score).toBe(0.72);
    expect(codexTraces[0].quality!.evaluator).toBe("claude");
    expect(codexTraces[0].quality!.feedback).toBe("Good but could be more detailed");
  });

  // ── Test 2: quality updates are merged into parent traces via query ──

  it("should merge quality updates into parent traces via query", async () => {
    const gemini = mockProvider("gemini", ["Gemini response"]);
    const deps: AgentToolDeps = {
      registry: mockRegistry([gemini]),
      sessionManager,
      memoryFacade,
      jobManager: jobMgr,
      documentManager,
      traceWriter,
    };

    const debateId = await createDebateWithTurns(deps, ["gemini"]);

    // Before conclude: trace exists but has no quality
    const tracesBefore = traceWriter.query({ traceId: debateId });
    expect(tracesBefore).toHaveLength(1);
    expect(tracesBefore[0].quality).toBeUndefined();

    // Conclude with quality score
    await handleTool(
      "agent_debate_conclude",
      {
        debate_id: debateId,
        quality_scores: [
          { provider: "gemini", score: 0.9, feedback: "Excellent contribution" },
        ],
      },
      deps,
    );

    // After conclude: query merges quality_update into the parent trace
    const tracesAfter = traceWriter.query({ traceId: debateId });
    expect(tracesAfter).toHaveLength(1);
    expect(tracesAfter[0].quality).toBeDefined();
    expect(tracesAfter[0].quality!.score).toBe(0.9);
    expect(tracesAfter[0].quality!.evaluator).toBe("claude");
    expect(tracesAfter[0].quality!.feedback).toBe("Excellent contribution");

    // Verify quality stats work correctly
    const stats = traceWriter.getQualityStats(7);
    const key = `gemini:Test debate`;
    expect(stats.has(key)).toBe(true);
    expect(stats.get(key)!.avgScore).toBe(0.9);
    expect(stats.get(key)!.count).toBe(1);
  });

  // ── Test 3: debate conclude still works without quality_scores (backward compat) ──

  it("should conclude debate successfully without quality_scores", async () => {
    const gemini = mockProvider("gemini", ["Gemini opinion"]);
    const codex = mockProvider("codex", ["Codex opinion"]);
    const deps: AgentToolDeps = {
      registry: mockRegistry([gemini, codex]),
      sessionManager,
      memoryFacade,
      jobManager: jobMgr,
      documentManager,
      traceWriter,
    };

    const debateId = await createDebateWithTurns(deps, ["gemini", "codex"]);

    // Conclude WITHOUT quality_scores — backward compatibility
    const concludeResult = await handleTool(
      "agent_debate_conclude",
      {
        debate_id: debateId,
        summary: "Simple conclusion",
      },
      deps,
    );

    expect(concludeResult.isError).toBeUndefined();
    expect(concludeResult.content[0].text).toContain("Debate concluded");
    expect(concludeResult.content[0].text).toContain("Test debate");
    expect(concludeResult.content[0].text).toContain("Simple conclusion");

    // Traces should exist but without quality
    const traces = traceWriter.query({ traceId: debateId });
    expect(traces).toHaveLength(2); // gemini + codex turns
    for (const t of traces) {
      expect(t.quality).toBeUndefined();
    }
  });

  // ── Test 4: no traceWriter — quality_scores are silently ignored ──

  it("should not error when quality_scores provided but traceWriter is undefined", async () => {
    const gemini = mockProvider("gemini", ["Gemini response"]);
    const deps: AgentToolDeps = {
      registry: mockRegistry([gemini]),
      sessionManager,
      memoryFacade,
      jobManager: jobMgr,
      documentManager,
      // traceWriter intentionally omitted
    };

    const createResult = await handleTool(
      "agent_debate_create",
      { topic: "No-trace debate", providers: ["gemini"], save_document: false },
      deps,
    );
    const debateId = createResult.content[0].text.match(/Debate ID:\*\* (\S+)/)![1];

    await handleTool(
      "agent_debate_turn",
      { debate_id: debateId, provider: "gemini" },
      deps,
    );

    // Conclude with quality_scores but no traceWriter — should not throw
    const concludeResult = await handleTool(
      "agent_debate_conclude",
      {
        debate_id: debateId,
        quality_scores: [
          { provider: "gemini", score: 0.8, feedback: "Good work" },
        ],
      },
      deps,
    );

    expect(concludeResult.isError).toBeUndefined();
    expect(concludeResult.content[0].text).toContain("Debate concluded");
  });

  // ── Test 5: quality score validation (0 to 1 range) ──

  it("should reject quality scores outside the 0-1 range", async () => {
    const gemini = mockProvider("gemini", ["Gemini response"]);
    const deps: AgentToolDeps = {
      registry: mockRegistry([gemini]),
      sessionManager,
      memoryFacade,
      jobManager: jobMgr,
      documentManager,
      traceWriter,
    };

    const createResult = await handleTool(
      "agent_debate_create",
      { topic: "Test", providers: ["gemini"], save_document: false },
      deps,
    );
    const debateId = createResult.content[0].text.match(/Debate ID:\*\* (\S+)/)![1];

    await handleTool(
      "agent_debate_turn",
      { debate_id: debateId, provider: "gemini" },
      deps,
    );

    // Score > 1 should fail Zod validation
    await expect(
      handleTool(
        "agent_debate_conclude",
        {
          debate_id: debateId,
          quality_scores: [
            { provider: "gemini", score: 1.5, feedback: "Invalid score" },
          ],
        },
        deps,
      ),
    ).rejects.toThrow();
  });

  // ── Test 6: tool definition includes quality_scores ──

  it("should include quality_scores in the agent_debate_conclude tool definition", async () => {
    const { getTools } = await import("../tools/agent-session.js");
    const tools = getTools();
    const concludeTool = tools.find((t) => t.name === "agent_debate_conclude");

    expect(concludeTool).toBeDefined();
    const props = concludeTool!.inputSchema.properties as Record<string, any>;
    expect(props.quality_scores).toBeDefined();
    expect(props.quality_scores.type).toBe("array");
    expect(props.quality_scores.items.properties.provider).toBeDefined();
    expect(props.quality_scores.items.properties.score).toBeDefined();
    expect(props.quality_scores.items.properties.feedback).toBeDefined();
    expect(props.quality_scores.items.required).toContain("provider");
    expect(props.quality_scores.items.required).toContain("score");
    expect(props.quality_scores.items.required).toContain("feedback");
  });
});
