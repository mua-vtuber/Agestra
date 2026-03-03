/**
 * E2E Memory Pipeline Test
 *
 * Tests the full memory lifecycle: create facade -> store knowledge ->
 * search -> integrity check -> rebuild indexes.
 * Uses real SQLite (temp directory) with mock EmbeddingProvider.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  MemoryFacade,
  checkIntegrity,
  rebuildIndexes,
} from "@agestra/memory";
import type {
  MemoryFacadeConfig,
  EmbeddingProvider,
  KnowledgeNodeCreate,
} from "@agestra/memory";

// ── Mock Embedding Provider ─────────────────────────────────────────

const mockEmbeddingProvider: EmbeddingProvider = {
  embed: async (text: string) => {
    // Simple deterministic mock: hash text into a vector
    const vec = new Array(128).fill(0);
    for (let i = 0; i < text.length && i < 128; i++) {
      vec[i % 128] += text.charCodeAt(i) / 1000;
    }
    // Normalize
    const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return mag > 0 ? vec.map((v) => v / mag) : vec;
  },
  modelId: "mock-embedding-v1",
  dimension: 128,
};

// ── Helpers ─────────────────────────────────────────────────────────

function createTestNode(overrides?: Partial<KnowledgeNodeCreate>): KnowledgeNodeCreate {
  return {
    content: "Default test content",
    nodeType: "fact",
    topic: "technical",
    importance: 0.5,
    source: "auto",
    ...overrides,
  };
}

// ── Test Suite ──────────────────────────────────────────────────────

describe("E2E: Memory Pipeline", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "e2e-memory-"));
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // ── 1. Create MemoryFacade -> store -> search -> returns results ──

  describe("Store knowledge and search", () => {
    it("should store knowledge nodes and retrieve them via search", async () => {
      const dbPath = join(tmpDir, "memory.db");
      const facade = new MemoryFacade({ dbPath });
      facade.initialize();

      try {
        // Store several knowledge nodes
        const id1 = facade.store(createTestNode({
          content: "TypeScript uses static typing to catch errors at compile time",
          topic: "technical",
          importance: 0.8,
        }));

        const id2 = facade.store(createTestNode({
          content: "React hooks allow functional components to use state",
          topic: "technical",
          importance: 0.7,
        }));

        const id3 = facade.store(createTestNode({
          content: "PostgreSQL supports JSON columns for flexible data storage",
          topic: "technical",
          importance: 0.6,
        }));

        expect(id1).toBeTruthy();
        expect(id2).toBeTruthy();
        expect(id3).toBeTruthy();

        // Search for TypeScript-related content
        const tsResults = await facade.search("TypeScript static typing");
        expect(tsResults.length).toBeGreaterThan(0);
        expect(tsResults[0].node.content).toContain("TypeScript");
        expect(tsResults[0].score).toBeGreaterThan(0);

        // Search for React-related content
        const reactResults = await facade.search("React hooks state");
        expect(reactResults.length).toBeGreaterThan(0);
        expect(reactResults[0].node.content).toContain("React");

        // Search for database content
        const dbResults = await facade.search("PostgreSQL JSON");
        expect(dbResults.length).toBeGreaterThan(0);
        expect(dbResults[0].node.content).toContain("PostgreSQL");
      } finally {
        facade.close();
      }
    });

    it("should return empty results for non-matching queries", async () => {
      const dbPath = join(tmpDir, "empty-search.db");
      const facade = new MemoryFacade({ dbPath });
      facade.initialize();

      try {
        facade.store(createTestNode({
          content: "Python is great for data science",
        }));

        const results = await facade.search("quantum computing blockchain");
        expect(results).toEqual([]);
      } finally {
        facade.close();
      }
    });

    it("should handle deduplication correctly", async () => {
      const dbPath = join(tmpDir, "dedupe.db");
      const facade = new MemoryFacade({ dbPath });
      facade.initialize();

      try {
        const id1 = facade.store(createTestNode({
          content: "Duplicate content for testing",
        }));
        const id2 = facade.store(createTestNode({
          content: "Duplicate content for testing",
        }));

        // Should return the same ID due to deduplication
        expect(id1).toBe(id2);

        // Only one result should be found
        const results = await facade.search("Duplicate content");
        expect(results.length).toBe(1);
      } finally {
        facade.close();
      }
    });
  });

  // ── 2. Store multiple items -> search returns ranked results ──────

  describe("Ranked search results", () => {
    it("should return results ranked by relevance score", async () => {
      const dbPath = join(tmpDir, "ranked.db");
      const facade = new MemoryFacade({ dbPath });
      facade.initialize();

      try {
        // Store items with varying relevance to "TypeScript"
        facade.store(createTestNode({
          content: "TypeScript is a typed superset of JavaScript that compiles to plain JavaScript",
          importance: 0.9,
        }));
        facade.store(createTestNode({
          content: "TypeScript generics allow writing reusable type-safe code",
          importance: 0.8,
        }));
        facade.store(createTestNode({
          content: "Python is a dynamically typed programming language",
          importance: 0.7,
        }));
        facade.store(createTestNode({
          content: "Rust provides memory safety without garbage collection",
          importance: 0.6,
        }));

        const results = await facade.search("TypeScript generics");
        expect(results.length).toBeGreaterThan(0);

        // Results should be sorted by score (descending)
        for (let i = 1; i < results.length; i++) {
          expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
        }

        // Top results should be TypeScript-related
        const topContent = results[0].node.content;
        expect(topContent.toLowerCase()).toContain("typescript");
      } finally {
        facade.close();
      }
    });

    it("should respect limit parameter in search", async () => {
      const dbPath = join(tmpDir, "limited.db");
      const facade = new MemoryFacade({ dbPath });
      facade.initialize();

      try {
        // Store many items
        for (let i = 0; i < 10; i++) {
          facade.store(createTestNode({
            content: `TypeScript feature number ${i}: generics, interfaces, etc.`,
          }));
        }

        const results = await facade.search("TypeScript", { limit: 3 });
        expect(results.length).toBeLessThanOrEqual(3);
      } finally {
        facade.close();
      }
    });

    it("should filter results by topic", async () => {
      const dbPath = join(tmpDir, "topic-filter.db");
      const facade = new MemoryFacade({ dbPath });
      facade.initialize();

      try {
        facade.store(createTestNode({
          content: "Use ESLint for code linting",
          topic: "technical",
        }));
        facade.store(createTestNode({
          content: "The team decided to use ESLint rules",
          topic: "decisions",
        }));
        facade.store(createTestNode({
          content: "Prefer strict ESLint configuration",
          topic: "preferences",
        }));

        const techResults = await facade.search("ESLint", { topic: "technical" });
        for (const r of techResults) {
          expect(r.node.topic).toBe("technical");
        }
      } finally {
        facade.close();
      }
    });
  });

  // ── 3. checkIntegrity -> returns ok ───────────────────────────────

  describe("checkIntegrity on the DB", () => {
    it("should return ok status for a healthy database", async () => {
      const dbPath = join(tmpDir, "healthy.db");
      const facade = new MemoryFacade({ dbPath });
      facade.initialize();

      // Store some data
      facade.store(createTestNode({ content: "Integrity test fact one" }));
      facade.store(createTestNode({ content: "Integrity test fact two" }));
      facade.store(createTestNode({ content: "Integrity test fact three" }));

      facade.close();

      const result = await checkIntegrity(dbPath);
      expect(result.status).toBe("ok");
      expect(result.details).toContain("ok");
      expect(result.nodeCount).toBe(3);
      expect(result.edgeCount).toBe(0);
      expect(result.ftsCount).toBe(3);
    });

    it("should return ok for an empty database", async () => {
      const dbPath = join(tmpDir, "empty-integrity.db");
      const facade = new MemoryFacade({ dbPath });
      facade.initialize();
      facade.close();

      const result = await checkIntegrity(dbPath);
      expect(result.status).toBe("ok");
      expect(result.nodeCount).toBe(0);
      expect(result.ftsCount).toBe(0);
    });

    it("should return corrupted for non-existent path", async () => {
      const badPath = join(tmpDir, "nonexistent", "bad.db");
      const result = await checkIntegrity(badPath);
      expect(result.status).toBe("corrupted");
      expect(result.nodeCount).toBe(0);
    });

    it("should verify FTS count matches node count", async () => {
      const dbPath = join(tmpDir, "fts-count.db");
      const facade = new MemoryFacade({ dbPath });
      facade.initialize();

      const numNodes = 5;
      for (let i = 0; i < numNodes; i++) {
        facade.store(createTestNode({
          content: `Unique content for FTS test item ${i}`,
        }));
      }
      facade.close();

      const result = await checkIntegrity(dbPath);
      expect(result.status).toBe("ok");
      expect(result.nodeCount).toBe(numNodes);
      expect(result.ftsCount).toBe(numNodes);
    });
  });

  // ── 4. rebuildIndexes -> search still works ───────────────────────

  describe("rebuildIndexes on the DB", () => {
    it("should rebuild indexes and search still works after", async () => {
      const dbPath = join(tmpDir, "rebuild.db");
      const facade = new MemoryFacade({ dbPath });
      facade.initialize();

      // Store data with content that matches well in FTS5
      facade.store(createTestNode({
        content: "JavaScript testing framework for fast execution",
        importance: 0.8,
      }));
      facade.store(createTestNode({
        content: "The standard testing runner was popular for integration",
        importance: 0.7,
      }));
      facade.store(createTestNode({
        content: "BDD style testing approach for JavaScript applications",
        importance: 0.6,
      }));

      // Search before rebuild
      const beforeResults = await facade.search("JavaScript testing");
      expect(beforeResults.length).toBeGreaterThan(0);

      facade.close();

      // Rebuild indexes
      const rebuildResult = await rebuildIndexes(dbPath);
      expect(rebuildResult.rebuiltIndexes).toContain("fts5");
      expect(rebuildResult.rebuiltIndexes).toContain("reindex");
      expect(rebuildResult.duration).toBeGreaterThanOrEqual(0);

      // Re-open and search after rebuild
      const facade2 = new MemoryFacade({ dbPath });
      facade2.initialize();

      try {
        const afterResults = await facade2.search("JavaScript testing");
        expect(afterResults.length).toBeGreaterThan(0);
        expect(afterResults[0].node.content).toContain("JavaScript");

        // All data should still be there - "testing" is in all three nodes
        const allResults = await facade2.search("testing");
        expect(allResults.length).toBeGreaterThanOrEqual(2);
      } finally {
        facade2.close();
      }
    });

    it("should rebuild indexes on empty database without error", async () => {
      const dbPath = join(tmpDir, "empty-rebuild.db");
      const facade = new MemoryFacade({ dbPath });
      facade.initialize();
      facade.close();

      const result = await rebuildIndexes(dbPath);
      expect(result.rebuiltIndexes).toContain("fts5");
      expect(result.rebuiltIndexes).toContain("reindex");
    });

    it("should maintain integrity after rebuild", async () => {
      const dbPath = join(tmpDir, "integrity-after-rebuild.db");
      const facade = new MemoryFacade({ dbPath });
      facade.initialize();

      for (let i = 0; i < 5; i++) {
        facade.store(createTestNode({
          content: `Rebuild integrity test node ${i}`,
        }));
      }
      facade.close();

      // Rebuild
      await rebuildIndexes(dbPath);

      // Verify integrity after rebuild
      const integrityResult = await checkIntegrity(dbPath);
      expect(integrityResult.status).toBe("ok");
      expect(integrityResult.nodeCount).toBe(5);
      expect(integrityResult.ftsCount).toBe(5);
    });
  });

  // ── Full pipeline: store -> search -> integrity -> rebuild -> search ──

  describe("Full memory pipeline lifecycle", () => {
    it("should handle the complete store -> search -> integrity -> rebuild -> search cycle", async () => {
      const dbPath = join(tmpDir, "full-pipeline.db");
      const facade = new MemoryFacade({ dbPath });
      facade.initialize();

      // Step 1: Store knowledge
      facade.store(createTestNode({
        content: "The project uses Turborepo for monorepo management",
        topic: "technical",
        importance: 0.8,
      }));
      facade.store(createTestNode({
        content: "We decided to use Vitest instead of Jest for testing",
        topic: "decisions",
        importance: 0.9,
      }));
      facade.store(createTestNode({
        content: "Team prefers TypeScript strict mode",
        topic: "preferences",
        importance: 0.7,
      }));

      // Step 2: Search and verify
      const searchResults = await facade.search("Turborepo monorepo");
      expect(searchResults.length).toBeGreaterThan(0);
      expect(searchResults[0].node.content).toContain("Turborepo");

      const decisionResults = await facade.search("Vitest Jest", { topic: "decisions" });
      for (const r of decisionResults) {
        expect(r.node.topic).toBe("decisions");
      }

      facade.close();

      // Step 3: Check integrity
      const integrity = await checkIntegrity(dbPath);
      expect(integrity.status).toBe("ok");
      expect(integrity.nodeCount).toBe(3);
      expect(integrity.ftsCount).toBe(3);

      // Step 4: Rebuild indexes
      const rebuild = await rebuildIndexes(dbPath);
      expect(rebuild.rebuiltIndexes).toContain("fts5");
      expect(rebuild.rebuiltIndexes).toContain("reindex");

      // Step 5: Post-rebuild integrity
      const postIntegrity = await checkIntegrity(dbPath);
      expect(postIntegrity.status).toBe("ok");
      expect(postIntegrity.nodeCount).toBe(3);
      expect(postIntegrity.ftsCount).toBe(3);

      // Step 6: Post-rebuild search
      const facade2 = new MemoryFacade({ dbPath });
      facade2.initialize();

      try {
        const postResults = await facade2.search("Turborepo monorepo");
        expect(postResults.length).toBeGreaterThan(0);
        expect(postResults[0].node.content).toContain("Turborepo");
      } finally {
        facade2.close();
      }
    });
  });

  // ── Memory with mock embedding provider ───────────────────────────

  describe("Memory with mock embedding provider", () => {
    it("should store and embed nodes, then search still works", async () => {
      const dbPath = join(tmpDir, "embedded.db");
      const facade = new MemoryFacade({
        dbPath,
        embeddingProvider: mockEmbeddingProvider,
        memoryConfig: { vectorEnabled: true },
      });
      facade.initialize();

      try {
        facade.store(createTestNode({
          content: "Embedding test: React is a UI library",
        }));
        facade.store(createTestNode({
          content: "Embedding test: Vue is another UI framework",
        }));

        // Wait for async embedding to complete
        await new Promise((r) => setTimeout(r, 100));

        // Search should still work (FTS5 + potential vector search)
        const results = await facade.search("React UI library");
        expect(results.length).toBeGreaterThan(0);
      } finally {
        facade.close();
      }
    });
  });

  // ── Node retrieval by ID ──────────────────────────────────────────

  describe("Node retrieval by ID", () => {
    it("should retrieve a stored node by its ID", async () => {
      const dbPath = join(tmpDir, "getnode.db");
      const facade = new MemoryFacade({ dbPath });
      facade.initialize();

      try {
        const id = facade.store(createTestNode({
          content: "Specific node for ID lookup",
          nodeType: "decision",
          topic: "decisions",
          importance: 0.9,
        }));

        const node = facade.getNode(id);
        expect(node).not.toBeNull();
        expect(node!.id).toBe(id);
        expect(node!.content).toBe("Specific node for ID lookup");
        expect(node!.nodeType).toBe("decision");
        expect(node!.topic).toBe("decisions");
        expect(node!.importance).toBe(0.9);
      } finally {
        facade.close();
      }
    });

    it("should return null for non-existent node ID", async () => {
      const dbPath = join(tmpDir, "nonode.db");
      const facade = new MemoryFacade({ dbPath });
      facade.initialize();

      try {
        const node = facade.getNode("nonexistent-uuid");
        expect(node).toBeNull();
      } finally {
        facade.close();
      }
    });
  });

  // ── Soft delete ───────────────────────────────────────────────────

  describe("Soft delete and search exclusion", () => {
    it("should not return deleted nodes in search results", async () => {
      const dbPath = join(tmpDir, "delete.db");
      const facade = new MemoryFacade({ dbPath });
      facade.initialize();

      try {
        const id = facade.store(createTestNode({
          content: "This node will be deleted for testing purposes",
        }));

        // Verify it appears in search
        let results = await facade.search("deleted for testing");
        expect(results.length).toBe(1);

        // Delete the node
        const deleted = facade.deleteNode(id);
        expect(deleted).toBe(true);

        // Verify it no longer appears in search
        results = await facade.search("deleted for testing");
        expect(results.length).toBe(0);

        // getNode should return null for deleted nodes
        const node = facade.getNode(id);
        expect(node).toBeNull();
      } finally {
        facade.close();
      }
    });
  });
});
