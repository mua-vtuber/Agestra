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
} from "@agestra/core";
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

function createMockMemoryFacade() {
  return {
    search: vi.fn().mockResolvedValue([]),
    store: vi.fn(),
    initialize: vi.fn(),
    close: vi.fn(),
    getAssembledContext: vi.fn(),
    addEdge: vi.fn(),
  } as any;
}

function createMockJobManager() {
  return {
    submit: vi.fn().mockReturnValue("mock-job-id"),
    getStatus: vi.fn().mockReturnValue(null),
    getResult: vi.fn().mockReturnValue(null),
    listJobs: vi.fn().mockReturnValue([]),
    cancel: vi.fn().mockReturnValue(false),
  } as any;
}

// ── Tests ────────────────────────────────────────────────────

describe("agent-session turn-based debate tools", () => {
  let tmpDir: string;
  let sessionManager: SessionManager;
  let documentManager: DocumentManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "debate-tools-test-"));
    sessionManager = new SessionManager(tmpDir);
    documentManager = new DocumentManager(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeDeps(providers: AIProvider[]): AgentToolDeps {
    return {
      registry: mockRegistry(providers),
      sessionManager,
      memoryFacade: createMockMemoryFacade(),
      jobManager: createMockJobManager(),
      documentManager,
    };
  }

  describe("getTools", () => {
    it("should include the 3 new debate tools", () => {
      const tools = getTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("agent_debate_create");
      expect(names).toContain("agent_debate_turn");
      expect(names).toContain("agent_debate_conclude");
    });

    it("should still include legacy agent_debate_start", () => {
      const tools = getTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("agent_debate_start");
    });
  });

  describe("agent_debate_create", () => {
    it("should create a debate and return ID", async () => {
      const deps = makeDeps([
        mockProvider("gemini", []),
        mockProvider("codex", []),
      ]);

      const result = await handleTool(
        "agent_debate_create",
        {
          topic: "API design",
          providers: ["gemini", "codex"],
          goal: "Choose the best API style",
        },
        deps,
      );

      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      expect(text).toContain("Debate created");
      expect(text).toContain("Debate ID:");
      expect(text).toContain("API design");
      expect(text).toContain("gemini, codex");
      expect(text).toContain("Document ID:");
    });

    it("should skip document creation when save_document is false", async () => {
      const deps = makeDeps([mockProvider("gemini", [])]);

      const result = await handleTool(
        "agent_debate_create",
        {
          topic: "test",
          providers: ["gemini"],
          save_document: false,
        },
        deps,
      );

      const text = result.content[0].text;
      expect(text).toContain("Debate created");
      expect(text).not.toContain("Document ID:");
    });

    it("should throw for unknown provider", async () => {
      const deps = makeDeps([]);

      await expect(
        handleTool(
          "agent_debate_create",
          { topic: "test", providers: ["nonexistent"] },
          deps,
        ),
      ).rejects.toThrow("Provider not found");
    });
  });

  describe("agent_debate_turn", () => {
    it("should execute a provider turn and return response", async () => {
      const gemini = mockProvider("gemini", ["REST is a proven approach"]);
      const deps = makeDeps([gemini]);

      // First create a debate
      const createResult = await handleTool(
        "agent_debate_create",
        { topic: "API design", providers: ["gemini"] },
        deps,
      );
      const debateId = createResult.content[0].text.match(/Debate ID:\*\* (\S+)/)![1];

      // Execute a turn
      const turnResult = await handleTool(
        "agent_debate_turn",
        { debate_id: debateId, provider: "gemini" },
        deps,
      );

      expect(turnResult.isError).toBeUndefined();
      expect(turnResult.content[0].text).toContain("gemini");
      expect(turnResult.content[0].text).toContain("REST is a proven approach");
    });

    it("should inject Claude's comment before provider turn", async () => {
      let capturedPrompt = "";
      const gemini: AIProvider = {
        ...mockProvider("gemini", []),
        chat: async (req: ChatRequest) => {
          capturedPrompt = req.prompt;
          return { text: "I agree with Claude", model: "mock", provider: "gemini" };
        },
      };
      const deps = makeDeps([gemini]);

      const createResult = await handleTool(
        "agent_debate_create",
        { topic: "API design", providers: ["gemini"] },
        deps,
      );
      const debateId = createResult.content[0].text.match(/Debate ID:\*\* (\S+)/)![1];

      await handleTool(
        "agent_debate_turn",
        {
          debate_id: debateId,
          provider: "gemini",
          claude_comment: "I think REST is simpler",
        },
        deps,
      );

      // Claude's comment should be in the prompt sent to gemini
      expect(capturedPrompt).toContain("claude:");
      expect(capturedPrompt).toContain("I think REST is simpler");
    });

    it("should record turns to workspace document", async () => {
      const gemini = mockProvider("gemini", ["REST response"]);
      const deps = makeDeps([gemini]);

      const createResult = await handleTool(
        "agent_debate_create",
        { topic: "API design", providers: ["gemini"] },
        deps,
      );
      const text = createResult.content[0].text;
      const debateId = text.match(/Debate ID:\*\* (\S+)/)![1];
      const docId = text.match(/Document ID:\*\* (\S+)/)![1];

      // Turn with claude comment
      await handleTool(
        "agent_debate_turn",
        {
          debate_id: debateId,
          provider: "gemini",
          claude_comment: "Claude's input",
        },
        deps,
      );

      // Read the document and verify comments
      const doc = await documentManager.read(docId);
      expect(doc.content).toContain("Claude");
      expect(doc.content).toContain("Claude's input");
      expect(doc.content).toContain("gemini");
      expect(doc.content).toContain("REST response");
    });

    it("should return error for non-existent debate", async () => {
      const deps = makeDeps([mockProvider("gemini", [])]);

      const result = await handleTool(
        "agent_debate_turn",
        { debate_id: "bad-id", provider: "gemini" },
        deps,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Debate not found");
    });

    it("should return error for concluded debate", async () => {
      const gemini = mockProvider("gemini", ["response"]);
      const deps = makeDeps([gemini]);

      const createResult = await handleTool(
        "agent_debate_create",
        { topic: "test", providers: ["gemini"] },
        deps,
      );
      const debateId = createResult.content[0].text.match(/Debate ID:\*\* (\S+)/)![1];

      // Conclude first
      await handleTool("agent_debate_conclude", { debate_id: debateId }, deps);

      // Try a turn
      const turnResult = await handleTool(
        "agent_debate_turn",
        { debate_id: debateId, provider: "gemini" },
        deps,
      );

      expect(turnResult.isError).toBe(true);
      expect(turnResult.content[0].text).toContain("concluded");
    });
  });

  describe("agent_debate_conclude", () => {
    it("should conclude debate and return transcript", async () => {
      const gemini = mockProvider("gemini", ["REST is best"]);
      const codex = mockProvider("codex", ["I agree"]);
      const deps = makeDeps([gemini, codex]);

      const createResult = await handleTool(
        "agent_debate_create",
        { topic: "API design", providers: ["gemini", "codex"] },
        deps,
      );
      const debateId = createResult.content[0].text.match(/Debate ID:\*\* (\S+)/)![1];

      // Run some turns
      await handleTool(
        "agent_debate_turn",
        { debate_id: debateId, provider: "gemini" },
        deps,
      );
      await handleTool(
        "agent_debate_turn",
        { debate_id: debateId, provider: "codex" },
        deps,
      );

      // Conclude
      const concludeResult = await handleTool(
        "agent_debate_conclude",
        {
          debate_id: debateId,
          summary: "Both agreed on REST",
        },
        deps,
      );

      expect(concludeResult.isError).toBeUndefined();
      const text = concludeResult.content[0].text;
      expect(text).toContain("Debate concluded");
      expect(text).toContain("API design");
      expect(text).toContain("Turns:");
      // 2 provider turns + 1 summary turn
      expect(text).toContain("3");
      expect(text).toContain("REST is best");
      expect(text).toContain("I agree");
      expect(text).toContain("Both agreed on REST");
    });

    it("should store finding in memory", async () => {
      const gemini = mockProvider("gemini", ["opinion"]);
      const deps = makeDeps([gemini]);

      const createResult = await handleTool(
        "agent_debate_create",
        { topic: "test topic", providers: ["gemini"], save_document: false },
        deps,
      );
      const debateId = createResult.content[0].text.match(/Debate ID:\*\* (\S+)/)![1];

      await handleTool(
        "agent_debate_turn",
        { debate_id: debateId, provider: "gemini" },
        deps,
      );
      await handleTool(
        "agent_debate_conclude",
        { debate_id: debateId },
        deps,
      );

      expect(deps.memoryFacade.store).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeType: "finding",
          topic: "context",
        }),
      );
    });

    it("should return error for non-existent debate", async () => {
      const deps = makeDeps([]);

      const result = await handleTool(
        "agent_debate_conclude",
        { debate_id: "bad-id" },
        deps,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Debate not found");
    });

    it("should add summary to workspace document", async () => {
      const gemini = mockProvider("gemini", ["response"]);
      const deps = makeDeps([gemini]);

      const createResult = await handleTool(
        "agent_debate_create",
        { topic: "test", providers: ["gemini"] },
        deps,
      );
      const text = createResult.content[0].text;
      const debateId = text.match(/Debate ID:\*\* (\S+)/)![1];
      const docId = text.match(/Document ID:\*\* (\S+)/)![1];

      await handleTool(
        "agent_debate_turn",
        { debate_id: debateId, provider: "gemini" },
        deps,
      );
      await handleTool(
        "agent_debate_conclude",
        { debate_id: debateId, summary: "Final conclusion" },
        deps,
      );

      const doc = await documentManager.read(docId);
      expect(doc.content).toContain("Claude (Summary)");
      expect(doc.content).toContain("Final conclusion");
    });
  });

  describe("full debate flow", () => {
    it("should run create -> turn -> turn -> conclude with document", async () => {
      const gemini = mockProvider("gemini", ["Gemini view 1", "Gemini view 2"]);
      const codex = mockProvider("codex", ["Codex view 1"]);
      const deps = makeDeps([gemini, codex]);

      // Create
      const createResult = await handleTool(
        "agent_debate_create",
        {
          topic: "Which database?",
          providers: ["gemini", "codex"],
          goal: "Choose a database",
        },
        deps,
      );
      const createText = createResult.content[0].text;
      const debateId = createText.match(/Debate ID:\*\* (\S+)/)![1];
      const docId = createText.match(/Document ID:\*\* (\S+)/)![1];

      // Turn 1: gemini with Claude comment
      await handleTool(
        "agent_debate_turn",
        {
          debate_id: debateId,
          provider: "gemini",
          claude_comment: "Let's consider PostgreSQL",
        },
        deps,
      );

      // Turn 2: codex
      await handleTool(
        "agent_debate_turn",
        { debate_id: debateId, provider: "codex" },
        deps,
      );

      // Turn 3: gemini round 2
      await handleTool(
        "agent_debate_turn",
        { debate_id: debateId, provider: "gemini" },
        deps,
      );

      // Conclude
      const concludeResult = await handleTool(
        "agent_debate_conclude",
        {
          debate_id: debateId,
          summary: "We chose PostgreSQL",
        },
        deps,
      );

      const concludeText = concludeResult.content[0].text;
      expect(concludeText).toContain("Debate concluded");
      expect(concludeText).toContain("Which database?");
      expect(concludeText).toContain("Document ID:");

      // Verify document has all comments
      const doc = await documentManager.read(docId);
      expect(doc.content).toContain("Let's consider PostgreSQL");
      expect(doc.content).toContain("Gemini view 1");
      expect(doc.content).toContain("Codex view 1");
      expect(doc.content).toContain("Gemini view 2");
      expect(doc.content).toContain("We chose PostgreSQL");
    });
  });
});
