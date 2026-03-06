import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getTools, handleTool, type WorkspaceToolDeps } from "../tools/workspace.js";
import { DocumentManager } from "@agestra/workspace";
import type {
  AIProvider,
  ChatRequest,
  ChatResponse,
  ProviderCapability,
  HealthStatus,
  ProviderRegistry,
} from "@agestra/core";
import type { SessionManager, Session } from "@agestra/agents";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ── Mock helpers ─────────────────────────────────────────────

function mockProvider(id: string, response: string, delay = 0): AIProvider {
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
    chat: async (_req: ChatRequest): Promise<ChatResponse> => {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      return {
        text: response,
        model: "mock-model",
        provider: id,
      };
    },
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
  const sessions = new Map<string, Session>();
  let counter = 0;

  return {
    createSession: vi.fn((type: string, config: Record<string, unknown>): Session => {
      const now = new Date().toISOString();
      const session: Session = {
        id: `session-${++counter}`,
        type: type as Session["type"],
        status: "pending",
        config,
        createdAt: now,
        updatedAt: now,
      };
      sessions.set(session.id, session);
      return session;
    }),
    getSession: vi.fn((id: string) => sessions.get(id)),
    listSessions: vi.fn(() => [...sessions.values()]),
    updateSessionStatus: vi.fn((id: string, status: Session["status"]) => {
      const s = sessions.get(id);
      if (s) {
        s.status = status;
        s.updatedAt = new Date().toISOString();
      }
    }),
    completeSession: vi.fn((id: string, result: string) => {
      const s = sessions.get(id);
      if (s) {
        s.status = "completed";
        s.result = result;
        s.updatedAt = new Date().toISOString();
      }
    }),
  } as unknown as SessionManager;
}

// ── Tests ────────────────────────────────────────────────────

describe("workspace tools", () => {
  let tmpDir: string;
  let documentManager: DocumentManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "workspace-test-"));
    documentManager = new DocumentManager(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("getTools", () => {
    it("should return 6 tool definitions", () => {
      const tools = getTools();
      expect(tools).toHaveLength(6);
      const names = tools.map((t) => t.name);
      expect(names).toContain("workspace_create_review");
      expect(names).toContain("workspace_request_review");
      expect(names).toContain("workspace_review_status");
      expect(names).toContain("workspace_add_comment");
      expect(names).toContain("workspace_read");
      expect(names).toContain("workspace_list");
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

  describe("workspace_create_review", () => {
    it("should create a review document and return details", async () => {
      const deps: WorkspaceToolDeps = {
        registry: mockRegistry([]),
        documentManager,
        sessionManager: mockSessionManager(),
      };

      const result = await handleTool(
        "workspace_create_review",
        {
          files: ["/src/main.ts", "/src/util.ts"],
          rules: ["No console.log", "Use strict types"],
        },
        deps,
      );

      expect(result.content).toHaveLength(1);
      const text = result.content[0].text;
      expect(text).toContain("Review created");
      expect(text).toContain("Document ID:");
      expect(text).toContain("/src/main.ts, /src/util.ts");
      expect(text).toContain("**Rules:** 2");
    });

    it("should throw for empty files array", async () => {
      const deps: WorkspaceToolDeps = {
        registry: mockRegistry([]),
        documentManager,
        sessionManager: mockSessionManager(),
      };

      await expect(
        handleTool(
          "workspace_create_review",
          { files: [], rules: ["rule1"] },
          deps,
        ),
      ).rejects.toThrow();
    });
  });

  describe("workspace_request_review", () => {
    it("should return session ID immediately (async)", async () => {
      const sessionMgr = mockSessionManager();
      const deps: WorkspaceToolDeps = {
        registry: mockRegistry([
          mockProvider("gemini", "Code looks clean. Consider adding error handling."),
        ]),
        documentManager,
        sessionManager: sessionMgr,
      };

      const doc = await documentManager.createReview({
        files: ["/src/app.ts"],
        rules: ["Test coverage"],
      });

      const result = await handleTool(
        "workspace_request_review",
        { doc_id: doc.id, provider: "gemini" },
        deps,
      );

      const text = result.content[0].text;
      expect(text).toContain("Review started (async)");
      expect(text).toContain("Session ID:");
      expect(text).toContain(doc.id);
      expect(text).toContain("gemini");
      expect(sessionMgr.createSession).toHaveBeenCalledWith("review", expect.objectContaining({
        doc_id: doc.id,
        providers: ["gemini"],
      }));
    });

    it("should support multiple providers", async () => {
      const sessionMgr = mockSessionManager();
      const deps: WorkspaceToolDeps = {
        registry: mockRegistry([
          mockProvider("gemini", "Review from gemini"),
          mockProvider("codex", "Review from codex"),
        ]),
        documentManager,
        sessionManager: sessionMgr,
      };

      const doc = await documentManager.createReview({
        files: ["/src/app.ts"],
        rules: [],
      });

      const result = await handleTool(
        "workspace_request_review",
        { doc_id: doc.id, provider: ["gemini", "codex"] },
        deps,
      );

      const text = result.content[0].text;
      expect(text).toContain("gemini, codex");
      expect(sessionMgr.createSession).toHaveBeenCalledWith("review", expect.objectContaining({
        providers: ["gemini", "codex"],
      }));
    });

    it("should add comments to document after async completion", async () => {
      const sessionMgr = mockSessionManager();
      const deps: WorkspaceToolDeps = {
        registry: mockRegistry([
          mockProvider("gemini", "Gemini review feedback"),
        ]),
        documentManager,
        sessionManager: sessionMgr,
      };

      const doc = await documentManager.createReview({
        files: ["/src/app.ts"],
        rules: [],
      });

      await handleTool(
        "workspace_request_review",
        { doc_id: doc.id, provider: "gemini" },
        deps,
      );

      // Wait for the fire-and-forget promises to settle
      await new Promise((r) => setTimeout(r, 50));

      const updatedDoc = await documentManager.read(doc.id);
      expect(updatedDoc.content).toContain("AI (gemini)");
      expect(updatedDoc.content).toContain("Gemini review feedback");
    });

    it("should throw for unknown provider", async () => {
      const deps: WorkspaceToolDeps = {
        registry: mockRegistry([]),
        documentManager,
        sessionManager: mockSessionManager(),
      };

      const doc = await documentManager.createReview({
        files: ["/src/app.ts"],
        rules: [],
      });

      await expect(
        handleTool(
          "workspace_request_review",
          { doc_id: doc.id, provider: "nonexistent" },
          deps,
        ),
      ).rejects.toThrow("Provider not found");
    });

    it("should throw for nonexistent document", async () => {
      const deps: WorkspaceToolDeps = {
        registry: mockRegistry([mockProvider("gemini", "review")]),
        documentManager,
        sessionManager: mockSessionManager(),
      };

      await expect(
        handleTool(
          "workspace_request_review",
          { doc_id: "nonexistent-id", provider: "gemini" },
          deps,
        ),
      ).rejects.toThrow("Document not found");
    });
  });

  describe("workspace_review_status", () => {
    it("should return session status", async () => {
      const sessionMgr = mockSessionManager();
      const deps: WorkspaceToolDeps = {
        registry: mockRegistry([
          mockProvider("gemini", "Feedback"),
        ]),
        documentManager,
        sessionManager: sessionMgr,
      };

      const doc = await documentManager.createReview({
        files: ["/src/app.ts"],
        rules: [],
      });

      // Start a review to create a session
      const reviewResult = await handleTool(
        "workspace_request_review",
        { doc_id: doc.id, provider: "gemini" },
        deps,
      );

      // Extract session ID from response
      const sessionIdMatch = reviewResult.content[0].text.match(/Session ID:\*\* (session-\d+)/);
      const sessionId = sessionIdMatch![1];

      const statusResult = await handleTool(
        "workspace_review_status",
        { session_id: sessionId },
        deps,
      );

      const text = statusResult.content[0].text;
      expect(text).toContain("Review Session Status");
      expect(text).toContain(sessionId);
      expect(text).toContain("gemini");
    });

    it("should return error for unknown session", async () => {
      const deps: WorkspaceToolDeps = {
        registry: mockRegistry([]),
        documentManager,
        sessionManager: mockSessionManager(),
      };

      const result = await handleTool(
        "workspace_review_status",
        { session_id: "nonexistent-session" },
        deps,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Session not found");
    });
  });

  describe("workspace_add_comment", () => {
    it("should add a comment to an existing document", async () => {
      const deps: WorkspaceToolDeps = {
        registry: mockRegistry([]),
        documentManager,
        sessionManager: mockSessionManager(),
      };

      const doc = await documentManager.createReview({
        files: ["/src/app.ts"],
        rules: [],
      });

      const result = await handleTool(
        "workspace_add_comment",
        {
          doc_id: doc.id,
          author: "Alice",
          content: "Looks good to me!",
        },
        deps,
      );

      const text = result.content[0].text;
      expect(text).toContain("Comment added");
      expect(text).toContain(doc.id);
      expect(text).toContain("Alice");
      expect(text).toContain("Looks good to me!");

      // Verify comment was saved
      const updatedDoc = await documentManager.read(doc.id);
      expect(updatedDoc.content).toContain("Alice");
      expect(updatedDoc.content).toContain("Looks good to me!");
    });

    it("should throw for nonexistent document", async () => {
      const deps: WorkspaceToolDeps = {
        registry: mockRegistry([]),
        documentManager,
        sessionManager: mockSessionManager(),
      };

      await expect(
        handleTool(
          "workspace_add_comment",
          { doc_id: "bad-id", author: "Bob", content: "text" },
          deps,
        ),
      ).rejects.toThrow("Document not found");
    });
  });

  describe("workspace_read", () => {
    it("should read an existing document", async () => {
      const deps: WorkspaceToolDeps = {
        registry: mockRegistry([]),
        documentManager,
        sessionManager: mockSessionManager(),
      };

      const doc = await documentManager.createReview({
        files: ["/src/main.ts"],
        rules: ["rule1"],
      });

      const result = await handleTool(
        "workspace_read",
        { doc_id: doc.id },
        deps,
      );

      const text = result.content[0].text;
      expect(text).toContain(doc.id);
      expect(text).toContain(doc.path);
      expect(text).toContain("/src/main.ts");
      expect(text).toContain("rule1");
    });

    it("should throw for nonexistent document", async () => {
      const deps: WorkspaceToolDeps = {
        registry: mockRegistry([]),
        documentManager,
        sessionManager: mockSessionManager(),
      };

      await expect(
        handleTool("workspace_read", { doc_id: "nonexistent" }, deps),
      ).rejects.toThrow("Document not found");
    });
  });

  describe("handleTool dispatcher", () => {
    it("should return error for unknown tool name", async () => {
      const deps: WorkspaceToolDeps = {
        registry: mockRegistry([]),
        documentManager,
        sessionManager: mockSessionManager(),
      };

      const result = await handleTool("nonexistent_tool", {}, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown tool");
    });
  });
});
