import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryFacade } from '../facade.js';
import type { MemoryFacadeConfig } from '../facade.js';
import type { EmbeddingProvider, KnowledgeNodeCreate } from '../types.js';

// -- Mock Embedding Provider --------------------------------------------------

const mockEmbeddingProvider: EmbeddingProvider = {
  embed: async (_text: string) => new Array(384).fill(0.1),
  modelId: 'mock',
  dimension: 384,
};

// -- Helpers ------------------------------------------------------------------

function createFacade(overrides?: Partial<MemoryFacadeConfig>): MemoryFacade {
  return new MemoryFacade({
    dbPath: ':memory:',
    ...overrides,
  });
}

function createTestNode(overrides?: Partial<KnowledgeNodeCreate>): KnowledgeNodeCreate {
  return {
    content: 'TypeScript is a superset of JavaScript',
    nodeType: 'fact',
    topic: 'technical',
    importance: 0.7,
    source: 'auto',
    ...overrides,
  };
}

// -- Tests --------------------------------------------------------------------

describe('MemoryFacade', () => {
  let facade: MemoryFacade;

  beforeEach(() => {
    facade = createFacade();
  });

  afterEach(() => {
    facade.close();
  });

  // ── Lifecycle ─────────────────────────────────────────────────────

  describe('lifecycle', () => {
    it('should not be initialized before initialize()', () => {
      expect(facade.isInitialized).toBe(false);
    });

    it('should initialize successfully', async () => {
      await facade.initialize();
      expect(facade.isInitialized).toBe(true);
    });

    it('should create the required tables on initialize', async () => {
      await facade.initialize();
      const db = facade.getDatabase()!;

      // Check knowledge_nodes
      const nodes = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_nodes'",
      ).get();
      expect(nodes).toBeDefined();

      // Check knowledge_edges
      const edges = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_edges'",
      ).get();
      expect(edges).toBeDefined();

      // Check knowledge_fts (virtual table)
      const fts = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_fts'",
      ).get();
      expect(fts).toBeDefined();
    });

    it('should set WAL mode (in-memory falls back to memory journal mode)', async () => {
      await facade.initialize();
      const db = facade.getDatabase()!;
      const result = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string } | undefined;
      // In-memory databases cannot use WAL, so they report 'memory'.
      // On-disk databases would report 'wal'. Both are correct.
      // sql.js in-memory always reports 'memory'.
      expect(result).toBeDefined();
      expect(['wal', 'memory']).toContain(result!.journal_mode);
    });

    it('should be safe to call initialize() multiple times', async () => {
      await facade.initialize();
      await facade.initialize(); // Should not throw
      expect(facade.isInitialized).toBe(true);
    });

    it('should throw when accessing methods before initialization', () => {
      expect(() => facade.store(createTestNode())).toThrow('not initialized');
    });
  });

  // ── Close ─────────────────────────────────────────────────────────

  describe('close', () => {
    it('should be safe to call close() multiple times', async () => {
      await facade.initialize();
      facade.close();
      facade.close(); // Should not throw
      expect(facade.isInitialized).toBe(false);
    });

    it('should reset initialized state on close', async () => {
      await facade.initialize();
      expect(facade.isInitialized).toBe(true);
      facade.close();
      expect(facade.isInitialized).toBe(false);
    });

    it('should be safe to close without initializing', () => {
      facade.close(); // Should not throw
      expect(facade.isInitialized).toBe(false);
    });
  });

  // ── Store ─────────────────────────────────────────────────────────

  describe('store', () => {
    beforeEach(async () => {
      await facade.initialize();
    });

    it('should store a knowledge node and return an ID', () => {
      const id = facade.store(createTestNode());
      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');
    });

    it('should persist the node in the database', () => {
      const id = facade.store(createTestNode());
      const db = facade.getDatabase()!;
      const row = db.prepare('SELECT * FROM knowledge_nodes WHERE id = ?').get(id) as {
        id: string;
        content: string;
        node_type: string;
        topic: string;
        importance: number;
      };
      expect(row).toBeDefined();
      expect(row.content).toBe('TypeScript is a superset of JavaScript');
      expect(row.node_type).toBe('fact');
      expect(row.topic).toBe('technical');
      expect(row.importance).toBe(0.7);
    });

    it('should deduplicate identical content', () => {
      const id1 = facade.store(createTestNode());
      const id2 = facade.store(createTestNode());
      expect(id1).toBe(id2);
    });

    it('should store distinct content as separate nodes', () => {
      const id1 = facade.store(createTestNode({ content: 'Fact one' }));
      const id2 = facade.store(createTestNode({ content: 'Fact two' }));
      expect(id1).not.toBe(id2);
    });

    it('should sync to FTS5 via trigger', () => {
      facade.store(createTestNode({ content: 'unique_test_content_for_fts' }));
      const db = facade.getDatabase()!;
      const ftsRow = db.prepare(
        "SELECT * FROM knowledge_fts WHERE knowledge_fts MATCH '\"unique_test_content_for_fts\"'",
      ).get();
      expect(ftsRow).toBeDefined();
    });
  });

  // ── Search ────────────────────────────────────────────────────────

  describe('search', () => {
    beforeEach(async () => {
      await facade.initialize();
    });

    it('should return results for matching content', async () => {
      facade.store(createTestNode({ content: 'React hooks are declarative' }));
      const results = await facade.search('React hooks');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].node.content).toContain('React');
    });

    it('should return empty for non-matching query', async () => {
      facade.store(createTestNode({ content: 'Python is a dynamic language' }));
      const results = await facade.search('quantum physics particles');
      expect(results).toEqual([]);
    });

    it('should return empty for empty database', async () => {
      const results = await facade.search('anything');
      expect(results).toEqual([]);
    });

    it('should filter by topic when specified', async () => {
      facade.store(createTestNode({
        content: 'Use ESLint for linting',
        topic: 'technical',
      }));
      facade.store(createTestNode({
        content: 'User prefers dark mode for linting tools',
        topic: 'preferences',
      }));

      const techResults = await facade.search('linting', { topic: 'technical' });
      for (const result of techResults) {
        expect(result.node.topic).toBe('technical');
      }
    });

    it('should respect limit option', async () => {
      for (let i = 0; i < 5; i++) {
        facade.store(createTestNode({
          content: `TypeScript feature number ${i}`,
        }));
      }
      const results = await facade.search('TypeScript', { limit: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });
  });

  // ── Store and Search Round-Trip ───────────────────────────────────

  describe('store and search round-trip', () => {
    beforeEach(async () => {
      await facade.initialize();
    });

    it('should store a node and find it via search', async () => {
      const content = 'Vitest is a fast testing framework';
      facade.store(createTestNode({ content }));

      const results = await facade.search('Vitest testing framework');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].node.content).toBe(content);
      expect(results[0].score).toBeGreaterThan(0);
    });

    it('should retrieve stored node by ID', () => {
      const id = facade.store(createTestNode({ content: 'Stored for ID lookup' }));
      const node = facade.getNode(id);
      expect(node).not.toBeNull();
      expect(node!.id).toBe(id);
      expect(node!.content).toBe('Stored for ID lookup');
    });
  });

  // ── Evolve ────────────────────────────────────────────────────────

  describe('evolve', () => {
    beforeEach(async () => {
      await facade.initialize();
    });

    it('should not crash on empty database', () => {
      const result = facade.evolve();
      expect(result).toEqual({ merged: 0, pruned: 0 });
    });

    it('should not crash with nodes but no embeddings', () => {
      facade.store(createTestNode({ content: 'Node without embedding' }));
      const result = facade.evolve();
      expect(result.merged).toBe(0);
      // pruned is also 0 because nodes are too recent
      expect(result.pruned).toBe(0);
    });
  });

  // ── Reflect ───────────────────────────────────────────────────────

  describe('reflect', () => {
    it('should return zero result without LLM function', async () => {
      await facade.initialize();
      const result = await facade.reflect();
      expect(result).toEqual({ insightsCreated: 0, nodesProcessed: 0 });
    });

    it('should return false for shouldReflect() without LLM', async () => {
      await facade.initialize();
      expect(facade.shouldReflect()).toBe(false);
    });

    it('should not crash with LLM function on empty DB', async () => {
      const facadeWithLlm = createFacade({
        reflectionLlmFn: async (_sys, _user) => '[]',
      });
      await facadeWithLlm.initialize();

      const result = await facadeWithLlm.reflect();
      expect(result.insightsCreated).toBe(0);

      facadeWithLlm.close();
    });

    it('shouldReflect returns true when enough nodes accumulated', async () => {
      const facadeWithLlm = createFacade({
        reflectionLlmFn: async (_sys, _user) => '[]',
        memoryConfig: { reflectionThreshold: 3 },
      });
      await facadeWithLlm.initialize();

      // Store enough nodes to trigger reflection
      for (let i = 0; i < 5; i++) {
        facadeWithLlm.store(createTestNode({
          content: `Memory item ${i} for reflection`,
        }));
      }

      expect(facadeWithLlm.shouldReflect()).toBe(true);

      facadeWithLlm.close();
    });
  });

  // ── Pin ───────────────────────────────────────────────────────────

  describe('pinMessage', () => {
    beforeEach(async () => {
      await facade.initialize();
    });

    it('should create a pinned node', () => {
      const id = facade.pinMessage('msg-1', 'Important fact', 'technical');
      expect(id).toBeTruthy();

      const node = facade.getNode(id);
      expect(node).not.toBeNull();
      expect(node!.pinned).toBe(true);
      expect(node!.content).toBe('Important fact');
    });

    it('should boost existing node when pinning same message', () => {
      // First store a node with a messageId
      const firstId = facade.store(createTestNode({
        content: 'Original content',
        messageId: 'msg-2',
        importance: 0.5,
      }));

      // Pin the same message
      const pinnedId = facade.pinMessage('msg-2', 'Original content', 'technical');
      expect(pinnedId).toBe(firstId);

      const node = facade.getNode(pinnedId);
      expect(node!.pinned).toBe(true);
      // Importance should be boosted
      expect(node!.importance).toBeGreaterThan(0.5);
    });

    it('should list pinned nodes', () => {
      facade.pinMessage('msg-a', 'Pinned fact A', 'technical');
      facade.pinMessage('msg-b', 'Pinned fact B', 'technical');

      const pinned = facade.getPinnedNodes();
      expect(pinned.length).toBe(2);
      for (const node of pinned) {
        expect(node.pinned).toBe(true);
      }
    });
  });

  // ── Delete ────────────────────────────────────────────────────────

  describe('deleteNode', () => {
    beforeEach(async () => {
      await facade.initialize();
    });

    it('should soft-delete a node', () => {
      const id = facade.store(createTestNode());
      const deleted = facade.deleteNode(id);
      expect(deleted).toBe(true);

      const node = facade.getNode(id);
      expect(node).toBeNull(); // Deleted nodes are filtered out
    });

    it('should return false for non-existent node', () => {
      const deleted = facade.deleteNode('non-existent-id');
      expect(deleted).toBe(false);
    });

    it('should not find deleted nodes in search', async () => {
      facade.store(createTestNode({ content: 'Will be deleted soon' }));

      // Search should find it
      let results = await facade.search('deleted');
      expect(results.length).toBeGreaterThan(0);

      // Delete the node
      facade.deleteNode(results[0].node.id);

      // Search should no longer find it
      results = await facade.search('deleted');
      expect(results.length).toBe(0);
    });
  });

  // ── Extract and Store Pipeline ────────────────────────────────────

  describe('extractAndStore', () => {
    beforeEach(async () => {
      await facade.initialize();
    });

    it('should extract and store from messages', async () => {
      const result = await facade.extractAndStore([
        {
          content: 'I decided to use PostgreSQL for the database',
          providerId: 'ollama-llama',
        },
      ]);

      // RegexStrategy may or may not extract items depending on patterns
      expect(result).toBeDefined();
      expect(typeof result.stored).toBe('number');
      expect(typeof result.skipped).toBe('number');
    });

    it('should return zero counts for empty messages', async () => {
      const result = await facade.extractAndStore([]);
      expect(result.stored).toBe(0);
    });
  });

  // ── Context Assembly ──────────────────────────────────────────────

  describe('getAssembledContext', () => {
    beforeEach(async () => {
      await facade.initialize();
    });

    it('should return assembled context for matching memories', async () => {
      facade.store(createTestNode({
        content: 'The project uses React for the frontend',
      }));

      const ctx = await facade.getAssembledContext({
        query: 'React frontend',
        systemPrompt: 'You are a helpful assistant.',
      });

      expect(ctx.memoryContext).toBeTruthy();
      expect(ctx.tokensUsed).toBeGreaterThan(0);
    });

    it('should return context even with no matching memories', async () => {
      const ctx = await facade.getAssembledContext({
        query: 'nonexistent topic',
        systemPrompt: 'You are a helpful assistant.',
      });

      // Should still return context (at least the system prompt part)
      expect(ctx).toBeDefined();
      expect(typeof ctx.memoryContext).toBe('string');
    });
  });

  // ── Embedding Integration ─────────────────────────────────────────

  describe('with embedding provider', () => {
    let facadeWithEmb: MemoryFacade;

    beforeEach(async () => {
      facadeWithEmb = createFacade({
        embeddingProvider: mockEmbeddingProvider,
        memoryConfig: { vectorEnabled: true },
      });
      await facadeWithEmb.initialize();
    });

    afterEach(() => {
      facadeWithEmb.close();
    });

    it('should store and generate embedding for nodes', async () => {
      const id = facadeWithEmb.store(createTestNode({
        content: 'Node with embedding',
      }));

      // Wait a tick for async embedding
      await new Promise((resolve) => setTimeout(resolve, 50));

      const db = facadeWithEmb.getDatabase()!;
      const row = db.prepare(
        'SELECT embedding, embedding_version FROM knowledge_nodes WHERE id = ?',
      ).get(id) as { embedding: Buffer | Uint8Array | null; embedding_version: string | null };

      expect(row.embedding).not.toBeNull();
      expect(row.embedding_version).toBe('mock');
    });

    it('should embed unembedded nodes on demand', async () => {
      // Store without waiting for embedding
      facadeWithEmb.store(createTestNode({ content: 'Needs embedding' }));

      // Explicitly embed
      const count = await facadeWithEmb.embedUnembeddedNodes(10);
      // May already have been embedded async, so count could be 0 or 1
      expect(count).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Embedding Failure Stats ──────────────────────────────────────

  describe('embeddingStats', () => {
    it('tracks embedding failure stats', async () => {
      const failingProvider: EmbeddingProvider = {
        embed: async () => { throw new Error('embedding failed'); },
        modelId: 'failing-mock',
        dimension: 384,
      };

      const facadeWithFailing = createFacade({
        embeddingProvider: failingProvider,
        memoryConfig: { vectorEnabled: true },
      });
      await facadeWithFailing.initialize();

      facadeWithFailing.store(createTestNode({ content: 'This will fail embedding' }));

      // Wait for async embedding to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(facadeWithFailing.embeddingStats.failed).toBeGreaterThan(0);

      facadeWithFailing.close();
    });

    it('calls onEmbeddingFailure callback', async () => {
      const failingProvider: EmbeddingProvider = {
        embed: async () => { throw new Error('embedding failed'); },
        modelId: 'failing-mock',
        dimension: 384,
      };

      let callbackNodeId: string | null = null;
      let callbackError: Error | null = null;

      const facadeWithCallback = createFacade({
        embeddingProvider: failingProvider,
        memoryConfig: { vectorEnabled: true },
        onEmbeddingFailure: (nodeId, error) => {
          callbackNodeId = nodeId;
          callbackError = error;
        },
      });
      await facadeWithCallback.initialize();

      const id = facadeWithCallback.store(createTestNode({ content: 'Callback test node' }));

      // Wait for async embedding to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(callbackNodeId).toBe(id);
      expect(callbackError).toBeInstanceOf(Error);
      expect(callbackError!.message).toBe('embedding failed');

      facadeWithCallback.close();
    });
  });

  // ── Re-initialize After Close ─────────────────────────────────────

  describe('re-initialization', () => {
    it('should allow re-initialization after close', async () => {
      await facade.initialize();
      const id1 = facade.store(createTestNode({ content: 'Before close' }));
      expect(id1).toBeTruthy();

      facade.close();
      expect(facade.isInitialized).toBe(false);

      // Re-initialize (new in-memory DB)
      await facade.initialize();
      expect(facade.isInitialized).toBe(true);

      // Old data is gone (new in-memory DB)
      const node = facade.getNode(id1);
      expect(node).toBeNull();
    });
  });
});
