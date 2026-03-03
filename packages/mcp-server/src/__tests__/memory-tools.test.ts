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
    getAssembledContext: vi.fn().mockResolvedValue({
      memoryContext: "",
      tokensUsed: 0,
    }),
    extractAndStore: vi.fn(),
    evolve: vi.fn(),
    shouldReflect: vi.fn().mockReturnValue(false),
    reflect: vi.fn(),
    pinMessage: vi.fn(),
    deleteNode: vi.fn(),
    embedUnembeddedNodes: vi.fn(),
    getDatabase: vi.fn(),
    addEdge: vi.fn().mockReturnValue("mock-edge-id"),
    ...overrides,
  } as unknown as MemoryFacade;
}

function makeRetrievalResult(id: string, content: string, score: number) {
  return {
    node: {
      id,
      content,
      nodeType: "dead_end",
      topic: "context",
      importance: 0.6,
      source: "auto",
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

describe("memory tools (new)", () => {
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

    it("should have valid inputSchema for each new tool", () => {
      const tools = getTools();
      const newTools = tools.filter((t) =>
        ["memory_store", "memory_dead_ends", "memory_context", "memory_add_edge"].includes(t.name),
      );
      expect(newTools).toHaveLength(4);
      for (const tool of newTools) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe("object");
        expect(tool.inputSchema.required).toBeDefined();
        expect(tool.description).toBeTruthy();
      }
    });
  });

  describe("memory_store", () => {
    it("should store a node and return its ID", async () => {
      const storeSpy = vi.fn().mockReturnValue("new-node-123");
      const facade = mockMemoryFacade({ store: storeSpy });
      const deps: MemoryToolDeps = { memoryFacade: facade };

      const result = await handleTool(
        "memory_store",
        {
          content: "React hooks require function components",
          node_type: "fact",
          topic: "technical",
          importance: 0.8,
          provider_id: "gemini",
        },
        deps,
      );

      const text = result.content[0].text;
      expect(text).toContain("Node stored");
      expect(text).toContain("new-node-123");
      expect(text).toContain("fact");
      expect(text).toContain("technical");
      expect(text).toContain("0.8");

      expect(storeSpy).toHaveBeenCalledWith({
        content: "React hooks require function components",
        nodeType: "fact",
        topic: "technical",
        importance: 0.8,
        source: "auto",
        providerId: "gemini",
      });
    });

    it("should store a dead_end node without provider_id", async () => {
      const storeSpy = vi.fn().mockReturnValue("dead-end-456");
      const facade = mockMemoryFacade({ store: storeSpy });
      const deps: MemoryToolDeps = { memoryFacade: facade };

      const result = await handleTool(
        "memory_store",
        {
          content: "Approach X failed due to timeout",
          node_type: "dead_end",
          topic: "context",
          importance: 0.6,
        },
        deps,
      );

      expect(result.content[0].text).toContain("dead-end-456");
      expect(result.content[0].text).toContain("dead_end");

      expect(storeSpy).toHaveBeenCalledWith({
        content: "Approach X failed due to timeout",
        nodeType: "dead_end",
        topic: "context",
        importance: 0.6,
        source: "auto",
        providerId: undefined,
      });
    });

    it("should throw for missing required fields", async () => {
      const deps: MemoryToolDeps = { memoryFacade: mockMemoryFacade() };

      await expect(
        handleTool("memory_store", { content: "test" }, deps),
      ).rejects.toThrow();
    });

    it("should throw for invalid node_type", async () => {
      const deps: MemoryToolDeps = { memoryFacade: mockMemoryFacade() };

      await expect(
        handleTool(
          "memory_store",
          {
            content: "test",
            node_type: "invalid_type",
            topic: "technical",
            importance: 0.5,
          },
          deps,
        ),
      ).rejects.toThrow();
    });

    it("should throw for importance out of range", async () => {
      const deps: MemoryToolDeps = { memoryFacade: mockMemoryFacade() };

      await expect(
        handleTool(
          "memory_store",
          {
            content: "test",
            node_type: "fact",
            topic: "technical",
            importance: 1.5,
          },
          deps,
        ),
      ).rejects.toThrow();
    });
  });

  describe("memory_dead_ends", () => {
    it("should search for dead_end nodes and return results", async () => {
      const searchSpy = vi.fn().mockResolvedValue([
        makeRetrievalResult("de-1", "Approach A timed out", 0.9),
        makeRetrievalResult("de-2", "Approach B had permission errors", 0.75),
      ]);
      const facade = mockMemoryFacade({ search: searchSpy });
      const deps: MemoryToolDeps = { memoryFacade: facade };

      const result = await handleTool(
        "memory_dead_ends",
        { query: "timeout errors" },
        deps,
      );

      const text = result.content[0].text;
      expect(text).toContain("Dead-End Records");
      expect(text).toContain("timeout errors");
      expect(text).toContain("**Results:** 2");
      expect(text).toContain("de-1");
      expect(text).toContain("Approach A timed out");
      expect(text).toContain("de-2");
      expect(text).toContain("Approach B had permission errors");

      expect(searchSpy).toHaveBeenCalledWith("timeout errors", {
        nodeType: "dead_end",
      });
    });

    it("should return message when no dead ends found", async () => {
      const facade = mockMemoryFacade({
        search: vi.fn().mockResolvedValue([]),
      });
      const deps: MemoryToolDeps = { memoryFacade: facade };

      const result = await handleTool(
        "memory_dead_ends",
        { query: "no failures here" },
        deps,
      );

      expect(result.content[0].text).toContain("No dead-end records found");
      expect(result.content[0].text).toContain("no failures here");
    });

    it("should throw for missing query", async () => {
      const deps: MemoryToolDeps = { memoryFacade: mockMemoryFacade() };

      await expect(
        handleTool("memory_dead_ends", {}, deps),
      ).rejects.toThrow();
    });
  });

  describe("memory_context", () => {
    it("should return assembled context", async () => {
      const getContextSpy = vi.fn().mockResolvedValue({
        memoryContext: "Relevant context about TypeScript patterns",
        tokensUsed: 150,
      });
      const facade = mockMemoryFacade({ getAssembledContext: getContextSpy });
      const deps: MemoryToolDeps = { memoryFacade: facade };

      const result = await handleTool(
        "memory_context",
        { query: "TypeScript patterns" },
        deps,
      );

      const text = result.content[0].text;
      expect(text).toContain("Assembled Context");
      expect(text).toContain("TypeScript patterns");
      expect(text).toContain("150");
      expect(text).toContain("Relevant context about TypeScript patterns");

      expect(getContextSpy).toHaveBeenCalledWith({
        query: "TypeScript patterns",
      });
    });

    it("should handle empty context", async () => {
      const facade = mockMemoryFacade({
        getAssembledContext: vi.fn().mockResolvedValue({
          memoryContext: "",
          tokensUsed: 0,
        }),
      });
      const deps: MemoryToolDeps = { memoryFacade: facade };

      const result = await handleTool(
        "memory_context",
        { query: "unknown topic" },
        deps,
      );

      const text = result.content[0].text;
      expect(text).toContain("Assembled Context");
      expect(text).toContain("**Tokens used:** 0");
    });

    it("should throw for missing query", async () => {
      const deps: MemoryToolDeps = { memoryFacade: mockMemoryFacade() };

      await expect(
        handleTool("memory_context", {}, deps),
      ).rejects.toThrow();
    });
  });

  describe("memory_add_edge", () => {
    it("should create an edge and return the edge ID", async () => {
      const addEdgeSpy = vi.fn().mockReturnValue("edge-789");
      const facade = mockMemoryFacade({ addEdge: addEdgeSpy });
      const deps: MemoryToolDeps = { memoryFacade: facade };

      const result = await handleTool(
        "memory_add_edge",
        {
          source_id: "node-a",
          target_id: "node-b",
          relation_type: "related_to",
        },
        deps,
      );

      const text = result.content[0].text;
      expect(text).toContain("Edge created");
      expect(text).toContain("edge-789");
      expect(text).toContain("node-a");
      expect(text).toContain("node-b");
      expect(text).toContain("related_to");

      expect(addEdgeSpy).toHaveBeenCalledWith("node-a", "node-b", "related_to");
    });

    it("should support all relation types", async () => {
      const relationTypes = [
        "related_to",
        "contradicts",
        "supersedes",
        "depends_on",
        "merged_from",
        "derived_from",
      ];

      for (const relType of relationTypes) {
        const addEdgeSpy = vi.fn().mockReturnValue(`edge-${relType}`);
        const facade = mockMemoryFacade({ addEdge: addEdgeSpy });
        const deps: MemoryToolDeps = { memoryFacade: facade };

        const result = await handleTool(
          "memory_add_edge",
          {
            source_id: "src",
            target_id: "tgt",
            relation_type: relType,
          },
          deps,
        );

        expect(result.content[0].text).toContain(relType);
        expect(addEdgeSpy).toHaveBeenCalledWith("src", "tgt", relType);
      }
    });

    it("should throw for invalid relation_type", async () => {
      const deps: MemoryToolDeps = { memoryFacade: mockMemoryFacade() };

      await expect(
        handleTool(
          "memory_add_edge",
          {
            source_id: "a",
            target_id: "b",
            relation_type: "invalid_relation",
          },
          deps,
        ),
      ).rejects.toThrow();
    });

    it("should throw for missing required fields", async () => {
      const deps: MemoryToolDeps = { memoryFacade: mockMemoryFacade() };

      await expect(
        handleTool("memory_add_edge", { source_id: "a" }, deps),
      ).rejects.toThrow();
    });
  });

  describe("handleTool dispatcher", () => {
    it("should dispatch to memory_store", async () => {
      const storeSpy = vi.fn().mockReturnValue("id");
      const facade = mockMemoryFacade({ store: storeSpy });
      const deps: MemoryToolDeps = { memoryFacade: facade };

      await handleTool(
        "memory_store",
        {
          content: "test",
          node_type: "finding",
          topic: "context",
          importance: 0.5,
        },
        deps,
      );

      expect(storeSpy).toHaveBeenCalled();
    });

    it("should dispatch to memory_dead_ends", async () => {
      const searchSpy = vi.fn().mockResolvedValue([]);
      const facade = mockMemoryFacade({ search: searchSpy });
      const deps: MemoryToolDeps = { memoryFacade: facade };

      await handleTool("memory_dead_ends", { query: "test" }, deps);

      expect(searchSpy).toHaveBeenCalledWith("test", { nodeType: "dead_end" });
    });

    it("should dispatch to memory_context", async () => {
      const ctxSpy = vi.fn().mockResolvedValue({ memoryContext: "", tokensUsed: 0 });
      const facade = mockMemoryFacade({ getAssembledContext: ctxSpy });
      const deps: MemoryToolDeps = { memoryFacade: facade };

      await handleTool("memory_context", { query: "test" }, deps);

      expect(ctxSpy).toHaveBeenCalled();
    });

    it("should dispatch to memory_add_edge", async () => {
      const edgeSpy = vi.fn().mockReturnValue("eid");
      const facade = mockMemoryFacade({ addEdge: edgeSpy });
      const deps: MemoryToolDeps = { memoryFacade: facade };

      await handleTool(
        "memory_add_edge",
        { source_id: "a", target_id: "b", relation_type: "supersedes" },
        deps,
      );

      expect(edgeSpy).toHaveBeenCalledWith("a", "b", "supersedes");
    });
  });
});
