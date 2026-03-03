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
    it("should return 4 tool definitions", () => {
      const tools = getTools();
      expect(tools).toHaveLength(4);
      const names = tools.map((t) => t.name);
      expect(names).toContain("workspace_create_review");
      expect(names).toContain("workspace_request_review");
      expect(names).toContain("workspace_add_comment");
      expect(names).toContain("workspace_read");
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
    it("should request review from AI provider and add comment", async () => {
      const deps: WorkspaceToolDeps = {
        registry: mockRegistry([
          mockProvider("gemini", "Code looks clean. Consider adding error handling."),
        ]),
        documentManager,
      };

      // Create a review first
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
      expect(text).toContain("Review completed");
      expect(text).toContain(doc.id);
      expect(text).toContain("gemini");
      expect(text).toContain("Code looks clean");

      // Verify comment was added to the document
      const updatedDoc = await documentManager.read(doc.id);
      expect(updatedDoc.content).toContain("AI (gemini)");
      expect(updatedDoc.content).toContain("Code looks clean");
    });

    it("should throw for unknown provider", async () => {
      const deps: WorkspaceToolDeps = {
        registry: mockRegistry([]),
        documentManager,
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

  describe("workspace_add_comment", () => {
    it("should add a comment to an existing document", async () => {
      const deps: WorkspaceToolDeps = {
        registry: mockRegistry([]),
        documentManager,
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
      };

      const result = await handleTool("nonexistent_tool", {}, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown tool");
    });
  });
});
