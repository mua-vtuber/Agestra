import { describe, it, expect, vi } from "vitest";
import { getTools, handleTool, type MemoryToolDeps } from "../tools/memory.js";
import type { MemoryFacade } from "@agestra/memory";

// ── Mock helpers ─────────────────────────────────────────────

function mockMemoryFacade(overrides?: Partial<MemoryFacade>): MemoryFacade {
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
    ...overrides,
  } as unknown as MemoryFacade;
}

function makeRetrievalResult(id: string, content: string, score: number) {
  return {
    node: {
      id,
      content,
      nodeType: "fact",
      topic: "project",
      importance: 0.5,
      source: "test",
      pinned: false,
      conversationId: null,
      messageId: null,
      lastAccessed: null,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      embeddingVersion: null,
      extractorVersion: null,
      sourceHash: null,
      dedupeKey: null,
      deletedAt: null,
      providerId: null,
      lastMentionedAt: null,
      mentionCount: 0,
      confidence: 0.5,
    },
    score,
    source: "fts" as const,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe("memory tools", () => {
  describe("getTools", () => {
    it("should return 6 tool definitions", () => {
      const tools = getTools();
      expect(tools).toHaveLength(6);
      const names = tools.map((t) => t.name);
      expect(names).toContain("memory_search");
      expect(names).toContain("memory_index");
      expect(names).toContain("memory_store");
      expect(names).toContain("memory_dead_ends");
      expect(names).toContain("memory_context");
      expect(names).toContain("memory_add_edge");
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

  describe("memory_search", () => {
    it("should search memory and return formatted results", async () => {
      const facade = mockMemoryFacade({
        search: vi.fn().mockResolvedValue([
          makeRetrievalResult("node-1", "TypeScript is a typed superset of JavaScript", 0.95),
          makeRetrievalResult("node-2", "Zod is a schema validation library", 0.72),
        ]),
      });

      const deps: MemoryToolDeps = { memoryFacade: facade };

      const result = await handleTool(
        "memory_search",
        { query: "TypeScript", top_k: 5 },
        deps,
      );

      const text = result.content[0].text;
      expect(text).toContain("Memory Search Results");
      expect(text).toContain("TypeScript");
      expect(text).toContain("**Results:** 2");
      expect(text).toContain("node-1");
      expect(text).toContain("0.950");
      expect(text).toContain("TypeScript is a typed superset");
      expect(text).toContain("node-2");
      expect(text).toContain("0.720");
      expect(text).toContain("Zod is a schema validation");

      // Verify search was called with correct args
      expect(facade.search).toHaveBeenCalledWith("TypeScript", { limit: 5 });
    });

    it("should use default top_k of 10", async () => {
      const facade = mockMemoryFacade({
        search: vi.fn().mockResolvedValue([]),
      });

      const deps: MemoryToolDeps = { memoryFacade: facade };

      await handleTool("memory_search", { query: "test" }, deps);

      expect(facade.search).toHaveBeenCalledWith("test", { limit: 10 });
    });

    it("should return message when no results found", async () => {
      const facade = mockMemoryFacade({
        search: vi.fn().mockResolvedValue([]),
      });

      const deps: MemoryToolDeps = { memoryFacade: facade };

      const result = await handleTool(
        "memory_search",
        { query: "nonexistent" },
        deps,
      );

      expect(result.content[0].text).toContain("No results found");
      expect(result.content[0].text).toContain("nonexistent");
    });

    it("should return error for missing query", async () => {
      const deps: MemoryToolDeps = { memoryFacade: mockMemoryFacade() };

      const result = await handleTool("memory_search", {}, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Memory operation failed");
    });

    it("should display node details correctly", async () => {
      const facade = mockMemoryFacade({
        search: vi.fn().mockResolvedValue([
          makeRetrievalResult("abc123", "Important fact", 0.88),
        ]),
      });

      const deps: MemoryToolDeps = { memoryFacade: facade };

      const result = await handleTool(
        "memory_search",
        { query: "important" },
        deps,
      );

      const text = result.content[0].text;
      expect(text).toContain("abc123");
      expect(text).toContain("fact");
      expect(text).toContain("project");
      expect(text).toContain("Important fact");
    });
  });

  describe("memory_index", () => {
    it("should index files and return count", async () => {
      const storeSpy = vi.fn().mockReturnValue("node-id");
      const facade = mockMemoryFacade({ store: storeSpy });

      const deps: MemoryToolDeps = { memoryFacade: facade };

      const result = await handleTool(
        "memory_index",
        { paths: ["/src/main.ts", "/src/util.ts"] },
        deps,
      );

      const text = result.content[0].text;
      expect(text).toContain("Indexing complete");
      expect(text).toContain("**Indexed:** 2");
      expect(text).toContain("**Errors:** 0");

      expect(storeSpy).toHaveBeenCalledTimes(2);
      expect(storeSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "auto",
          nodeType: "fact",
          topic: "context",
          content: "Indexed file: /src/main.ts",
        }),
      );
      expect(storeSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "Indexed file: /src/util.ts",
        }),
      );
    });

    it("should handle errors during indexing", async () => {
      let callCount = 0;
      const storeSpy = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 2) throw new Error("Storage failed");
        return "node-id";
      });
      const facade = mockMemoryFacade({ store: storeSpy });

      const deps: MemoryToolDeps = { memoryFacade: facade };

      const result = await handleTool(
        "memory_index",
        { paths: ["/src/good.ts", "/src/bad.ts", "/src/ok.ts"] },
        deps,
      );

      const text = result.content[0].text;
      expect(text).toContain("**Indexed:** 2");
      expect(text).toContain("**Errors:** 1");
      expect(text).toContain("/src/bad.ts");
      expect(text).toContain("Storage failed");
    });

    it("should set isError when all indexing fails", async () => {
      const storeSpy = vi.fn().mockImplementation(() => {
        throw new Error("All fail");
      });
      const facade = mockMemoryFacade({ store: storeSpy });

      const deps: MemoryToolDeps = { memoryFacade: facade };

      const result = await handleTool(
        "memory_index",
        { paths: ["/src/a.ts"] },
        deps,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("**Errors:** 1");
    });

    it("should return error for empty paths", async () => {
      const deps: MemoryToolDeps = { memoryFacade: mockMemoryFacade() };

      const result = await handleTool("memory_index", { paths: [] }, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Memory operation failed");
    });
  });

  describe("handleTool dispatcher", () => {
    it("should return error for unknown tool name", async () => {
      const deps: MemoryToolDeps = { memoryFacade: mockMemoryFacade() };

      const result = await handleTool("nonexistent_tool", {}, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown tool");
    });
  });
});
