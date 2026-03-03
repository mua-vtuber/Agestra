import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MemoryEvolver } from '../evolver.js';
import { EmbeddingService } from '../embedding-service.js';
import type { MemoryConfig } from '../types.js';

// -- Test Helpers -----------------------------------------------------------

/** Create an in-memory SQLite database with the required schema. */
function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_nodes (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      embedding BLOB,
      node_type TEXT NOT NULL,
      topic TEXT NOT NULL,
      importance REAL DEFAULT 0.5,
      source TEXT,
      pinned INTEGER DEFAULT 0,
      conversation_id TEXT,
      message_id TEXT,
      last_accessed DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      embedding_version TEXT,
      extractor_version TEXT,
      source_hash TEXT,
      dedupe_key TEXT,
      deleted_at DATETIME,
      provider_id TEXT,
      last_mentioned_at DATETIME,
      mention_count INTEGER DEFAULT 0,
      confidence REAL DEFAULT 0.5
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
      content,
      content=knowledge_nodes,
      content_rowid=rowid,
      tokenize='unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS knowledge_fts_insert
    AFTER INSERT ON knowledge_nodes
    BEGIN
      INSERT INTO knowledge_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
    END;

    CREATE TRIGGER IF NOT EXISTS knowledge_fts_update
    AFTER UPDATE OF content ON knowledge_nodes
    BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, content) VALUES ('delete', OLD.rowid, OLD.content);
      INSERT INTO knowledge_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
    END;

    CREATE TRIGGER IF NOT EXISTS knowledge_fts_delete
    AFTER UPDATE OF deleted_at ON knowledge_nodes
    WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
    BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, content) VALUES ('delete', OLD.rowid, OLD.content);
    END;

    CREATE TABLE IF NOT EXISTS knowledge_edges (
      id TEXT PRIMARY KEY,
      source_node_id TEXT REFERENCES knowledge_nodes(id),
      target_node_id TEXT REFERENCES knowledge_nodes(id),
      relation_type TEXT NOT NULL,
      weight REAL DEFAULT 1.0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  return db;
}

/**
 * Insert a test node into the database.
 * Optionally provide an embedding as a number array (will be serialized to blob).
 */
function insertTestNode(
  db: Database.Database,
  opts: {
    id: string;
    content: string;
    nodeType?: string;
    topic?: string;
    importance?: number;
    source?: string;
    pinned?: number;
    embedding?: number[];
    createdAt?: string;
    deletedAt?: string | null;
  },
): void {
  const now = new Date().toISOString();
  const embeddingBlob = opts.embedding
    ? EmbeddingService.vectorToBlob(opts.embedding)
    : null;

  db.prepare(
    `INSERT INTO knowledge_nodes
     (id, content, embedding, node_type, topic, importance, source, pinned,
      last_accessed, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.content,
    embeddingBlob,
    opts.nodeType ?? 'fact',
    opts.topic ?? 'technical',
    opts.importance ?? 0.5,
    opts.source ?? 'auto',
    opts.pinned ?? 0,
    now,
    opts.createdAt ?? now,
    now,
    opts.deletedAt ?? null,
  );
}

/** Create a date string N days in the past. */
function daysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

/**
 * Create a mock EmbeddingService with configurable availability.
 */
function createMockEmbeddingService(available: boolean): EmbeddingService {
  if (!available) {
    // No provider means available === false
    return new EmbeddingService();
  }
  return new EmbeddingService({
    embed: async () => null,
    modelId: 'test-model',
    dimension: 3,
  });
}

// -- Tests ------------------------------------------------------------------

describe('MemoryEvolver', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  // -- evolve ---------------------------------------------------------------

  describe('evolve', () => {
    it('returns {merged: 0, pruned: 0} on empty DB', () => {
      const embeddingService = createMockEmbeddingService(true);
      const evolver = new MemoryEvolver(db, embeddingService);

      const result = evolver.evolve();

      expect(result).toEqual({ merged: 0, pruned: 0 });
    });
  });

  // -- mergeSimilar ---------------------------------------------------------

  describe('mergeSimilar (via evolve)', () => {
    it('merges nodes above similarity threshold', () => {
      // Two nearly identical vectors (cosine similarity ~ 1.0)
      const vecA = [1.0, 0.0, 0.0];
      const vecB = [0.99, 0.01, 0.0];

      insertTestNode(db, {
        id: 'n1',
        content: 'Node A',
        importance: 0.8,
        embedding: vecA,
      });
      insertTestNode(db, {
        id: 'n2',
        content: 'Node B',
        importance: 0.6,
        embedding: vecB,
      });

      const embeddingService = createMockEmbeddingService(true);
      const config: Partial<MemoryConfig> = {
        mergeSimilarityThreshold: 0.85,
        mergeMaxCandidates: 200,
      };
      const evolver = new MemoryEvolver(db, embeddingService, config);

      const result = evolver.evolve();

      expect(result.merged).toBe(1);

      // Verify n2 (lower importance) was soft-deleted
      const n2 = db
        .prepare('SELECT deleted_at FROM knowledge_nodes WHERE id = ?')
        .get('n2') as { deleted_at: string | null };
      expect(n2.deleted_at).not.toBeNull();

      // Verify n1 (higher importance) is still alive
      const n1 = db
        .prepare('SELECT deleted_at FROM knowledge_nodes WHERE id = ?')
        .get('n1') as { deleted_at: string | null };
      expect(n1.deleted_at).toBeNull();
    });

    it('keeps the higher importance node', () => {
      // Same direction vectors, but node B has higher importance
      const vec = [1.0, 0.0, 0.0];

      insertTestNode(db, {
        id: 'n1',
        content: 'Low importance',
        importance: 0.3,
        embedding: vec,
      });
      insertTestNode(db, {
        id: 'n2',
        content: 'High importance',
        importance: 0.9,
        embedding: vec,
      });

      const embeddingService = createMockEmbeddingService(true);
      const config: Partial<MemoryConfig> = {
        mergeSimilarityThreshold: 0.85,
      };
      const evolver = new MemoryEvolver(db, embeddingService, config);

      evolver.evolve();

      // n1 should be soft-deleted (lower importance)
      const n1 = db
        .prepare('SELECT deleted_at FROM knowledge_nodes WHERE id = ?')
        .get('n1') as { deleted_at: string | null };
      expect(n1.deleted_at).not.toBeNull();

      // n2 should be kept (higher importance)
      const n2 = db
        .prepare('SELECT deleted_at FROM knowledge_nodes WHERE id = ?')
        .get('n2') as { deleted_at: string | null };
      expect(n2.deleted_at).toBeNull();
    });

    it('creates merged_from edge', () => {
      const vec = [1.0, 0.0, 0.0];

      insertTestNode(db, {
        id: 'n1',
        content: 'Node A',
        importance: 0.8,
        embedding: vec,
      });
      insertTestNode(db, {
        id: 'n2',
        content: 'Node B',
        importance: 0.6,
        embedding: vec,
      });

      const embeddingService = createMockEmbeddingService(true);
      const config: Partial<MemoryConfig> = {
        mergeSimilarityThreshold: 0.85,
      };
      const evolver = new MemoryEvolver(db, embeddingService, config);

      evolver.evolve();

      const edge = db
        .prepare(
          `SELECT source_node_id, target_node_id, relation_type, weight
           FROM knowledge_edges
           WHERE relation_type = 'merged_from'`,
        )
        .get() as {
        source_node_id: string;
        target_node_id: string;
        relation_type: string;
        weight: number;
      } | undefined;

      expect(edge).toBeDefined();
      expect(edge?.source_node_id).toBe('n1'); // keep node
      expect(edge?.target_node_id).toBe('n2'); // discarded node
      expect(edge?.relation_type).toBe('merged_from');
      expect(edge?.weight).toBeGreaterThan(0.85);
    });

    it('skips when embedding service is unavailable', () => {
      const vec = [1.0, 0.0, 0.0];

      insertTestNode(db, {
        id: 'n1',
        content: 'Node A',
        importance: 0.8,
        embedding: vec,
      });
      insertTestNode(db, {
        id: 'n2',
        content: 'Node B',
        importance: 0.6,
        embedding: vec,
      });

      const embeddingService = createMockEmbeddingService(false);
      const evolver = new MemoryEvolver(db, embeddingService);

      const result = evolver.evolve();

      expect(result.merged).toBe(0);

      // Both nodes should still be alive
      const rows = db
        .prepare(
          'SELECT COUNT(*) as cnt FROM knowledge_nodes WHERE deleted_at IS NULL',
        )
        .get() as { cnt: number };
      expect(rows.cnt).toBe(2);
    });

    it('respects mergeMaxCandidates limit', () => {
      // Create 5 identical-vector nodes, but limit candidates to 3
      const vec = [1.0, 0.0, 0.0];
      for (let i = 0; i < 5; i++) {
        insertTestNode(db, {
          id: `n${i}`,
          content: `Node ${i}`,
          importance: 0.5 + i * 0.01,
          embedding: vec,
        });
      }

      const embeddingService = createMockEmbeddingService(true);
      const config: Partial<MemoryConfig> = {
        mergeSimilarityThreshold: 0.85,
        mergeMaxCandidates: 3,
      };
      const evolver = new MemoryEvolver(db, embeddingService, config);

      const result = evolver.evolve();

      // Only 3 candidates fetched, so at most 2 can be merged
      // (keep the highest importance one among the 3)
      expect(result.merged).toBeLessThanOrEqual(2);
      expect(result.merged).toBeGreaterThan(0);
    });

    it('does not merge nodes below similarity threshold', () => {
      // Two orthogonal vectors (cosine similarity = 0.0)
      const vecA = [1.0, 0.0, 0.0];
      const vecB = [0.0, 1.0, 0.0];

      insertTestNode(db, {
        id: 'n1',
        content: 'Node A',
        importance: 0.8,
        embedding: vecA,
      });
      insertTestNode(db, {
        id: 'n2',
        content: 'Node B',
        importance: 0.6,
        embedding: vecB,
      });

      const embeddingService = createMockEmbeddingService(true);
      const config: Partial<MemoryConfig> = {
        mergeSimilarityThreshold: 0.85,
      };
      const evolver = new MemoryEvolver(db, embeddingService, config);

      const result = evolver.evolve();

      expect(result.merged).toBe(0);
    });

    it('optimization produces same merge results', () => {
      // Create nodes with known embeddings where some should merge and some should not.
      // The norm-ratio pre-filter should not change which nodes get merged.

      // Nearly identical vectors (should merge)
      const vecA = [1.0, 0.1, 0.0];
      const vecB = [0.98, 0.12, 0.0];

      // Orthogonal vector (should NOT merge with A or B)
      const vecC = [0.0, 0.0, 1.0];

      // Another vector similar to C (should merge with C)
      const vecD = [0.01, 0.0, 0.99];

      insertTestNode(db, { id: 'opt-a', content: 'Node A', importance: 0.9, embedding: vecA });
      insertTestNode(db, { id: 'opt-b', content: 'Node B', importance: 0.5, embedding: vecB });
      insertTestNode(db, { id: 'opt-c', content: 'Node C', importance: 0.8, embedding: vecC });
      insertTestNode(db, { id: 'opt-d', content: 'Node D', importance: 0.4, embedding: vecD });

      const embeddingService = createMockEmbeddingService(true);
      const config: Partial<MemoryConfig> = {
        mergeSimilarityThreshold: 0.85,
        mergeMaxCandidates: 200,
      };
      const evolver = new MemoryEvolver(db, embeddingService, config);

      const result = evolver.evolve();

      // A and B should merge (very similar), C and D should merge (very similar)
      expect(result.merged).toBe(2);

      // A (higher importance) should survive, B should be soft-deleted
      const optA = db.prepare('SELECT deleted_at FROM knowledge_nodes WHERE id = ?').get('opt-a') as { deleted_at: string | null };
      const optB = db.prepare('SELECT deleted_at FROM knowledge_nodes WHERE id = ?').get('opt-b') as { deleted_at: string | null };
      expect(optA.deleted_at).toBeNull();
      expect(optB.deleted_at).not.toBeNull();

      // C (higher importance) should survive, D should be soft-deleted
      const optC = db.prepare('SELECT deleted_at FROM knowledge_nodes WHERE id = ?').get('opt-c') as { deleted_at: string | null };
      const optD = db.prepare('SELECT deleted_at FROM knowledge_nodes WHERE id = ?').get('opt-d') as { deleted_at: string | null };
      expect(optC.deleted_at).toBeNull();
      expect(optD.deleted_at).not.toBeNull();
    });

    it('does not merge nodes without embeddings', () => {
      insertTestNode(db, {
        id: 'n1',
        content: 'Node A without embedding',
        importance: 0.8,
      });
      insertTestNode(db, {
        id: 'n2',
        content: 'Node B without embedding',
        importance: 0.6,
      });

      const embeddingService = createMockEmbeddingService(true);
      const evolver = new MemoryEvolver(db, embeddingService);

      const result = evolver.evolve();

      expect(result.merged).toBe(0);
    });
  });

  // -- pruneStale -----------------------------------------------------------

  describe('pruneStale (via evolve)', () => {
    const pruneConfig: Partial<MemoryConfig> = {
      pruneImportanceThreshold: 0.2,
      recencyHalfLifeDays: 30,
      // Disable merge so we only test prune behavior
      mergeSimilarityThreshold: 1.0,
    };

    it('removes old low-importance nodes', () => {
      // Node created 90 days ago with low importance (threshold: 2 * 30 = 60 days)
      insertTestNode(db, {
        id: 'n1',
        content: 'Old low importance node',
        importance: 0.1,
        createdAt: daysAgo(90),
      });

      const embeddingService = createMockEmbeddingService(false);
      const evolver = new MemoryEvolver(db, embeddingService, pruneConfig);

      const result = evolver.evolve();

      expect(result.pruned).toBe(1);

      const row = db
        .prepare('SELECT deleted_at FROM knowledge_nodes WHERE id = ?')
        .get('n1') as { deleted_at: string | null };
      expect(row.deleted_at).not.toBeNull();
    });

    it('does not prune pinned nodes', () => {
      // Old, low importance, but pinned
      insertTestNode(db, {
        id: 'n1',
        content: 'Pinned node',
        importance: 0.1,
        pinned: 1,
        createdAt: daysAgo(90),
      });

      const embeddingService = createMockEmbeddingService(false);
      const evolver = new MemoryEvolver(db, embeddingService, pruneConfig);

      const result = evolver.evolve();

      expect(result.pruned).toBe(0);

      const row = db
        .prepare('SELECT deleted_at FROM knowledge_nodes WHERE id = ?')
        .get('n1') as { deleted_at: string | null };
      expect(row.deleted_at).toBeNull();
    });

    it('does not prune high-importance nodes', () => {
      // Old, but importance above threshold
      insertTestNode(db, {
        id: 'n1',
        content: 'High importance node',
        importance: 0.8,
        createdAt: daysAgo(90),
      });

      const embeddingService = createMockEmbeddingService(false);
      const evolver = new MemoryEvolver(db, embeddingService, pruneConfig);

      const result = evolver.evolve();

      expect(result.pruned).toBe(0);

      const row = db
        .prepare('SELECT deleted_at FROM knowledge_nodes WHERE id = ?')
        .get('n1') as { deleted_at: string | null };
      expect(row.deleted_at).toBeNull();
    });

    it('does not prune recent nodes', () => {
      // Low importance, but created recently (within 2 * halfLife)
      insertTestNode(db, {
        id: 'n1',
        content: 'Recent low importance node',
        importance: 0.1,
        createdAt: daysAgo(10),
      });

      const embeddingService = createMockEmbeddingService(false);
      const evolver = new MemoryEvolver(db, embeddingService, pruneConfig);

      const result = evolver.evolve();

      expect(result.pruned).toBe(0);

      const row = db
        .prepare('SELECT deleted_at FROM knowledge_nodes WHERE id = ?')
        .get('n1') as { deleted_at: string | null };
      expect(row.deleted_at).toBeNull();
    });

    it('does not prune already soft-deleted nodes', () => {
      insertTestNode(db, {
        id: 'n1',
        content: 'Already deleted',
        importance: 0.1,
        createdAt: daysAgo(90),
        deletedAt: daysAgo(5),
      });

      const embeddingService = createMockEmbeddingService(false);
      const evolver = new MemoryEvolver(db, embeddingService, pruneConfig);

      const result = evolver.evolve();

      expect(result.pruned).toBe(0);
    });

    it('prunes multiple eligible nodes at once', () => {
      for (let i = 0; i < 5; i++) {
        insertTestNode(db, {
          id: `stale-${i}`,
          content: `Stale node ${i}`,
          importance: 0.1,
          createdAt: daysAgo(90),
        });
      }
      // One node that should NOT be pruned (high importance)
      insertTestNode(db, {
        id: 'keeper',
        content: 'Important node',
        importance: 0.9,
        createdAt: daysAgo(90),
      });

      const embeddingService = createMockEmbeddingService(false);
      const evolver = new MemoryEvolver(db, embeddingService, pruneConfig);

      const result = evolver.evolve();

      expect(result.pruned).toBe(5);

      const alive = db
        .prepare(
          'SELECT COUNT(*) as cnt FROM knowledge_nodes WHERE deleted_at IS NULL',
        )
        .get() as { cnt: number };
      expect(alive.cnt).toBe(1);
    });
  });
});
