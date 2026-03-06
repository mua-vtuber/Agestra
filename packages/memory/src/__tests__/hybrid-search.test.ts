import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteDatabase } from '../db-adapter.js';
import {
  HybridSearch,
  isVecTableAvailable,
  tryInitVecTable,
} from '../hybrid-search.js';
import type { RetrievalPipelineData } from '../types.js';
import { EmbeddingService } from '../embedding-service.js';

/** Create an in-memory SQLite database with the required schema. */
async function createTestDb(): Promise<SqliteDatabase> {
  const db = await SqliteDatabase.create(':memory:');
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

function insertTestNode(
  db: SqliteDatabase,
  opts: {
    id: string;
    content: string;
    nodeType?: string;
    topic?: string;
    importance?: number;
    lastAccessed?: string;
    pinned?: number;
  },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO knowledge_nodes
     (id, content, node_type, topic, importance, source, pinned, last_accessed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'auto', ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.content,
    opts.nodeType ?? 'fact',
    opts.topic ?? 'technical',
    opts.importance ?? 0.5,
    opts.pinned ?? 0,
    opts.lastAccessed ?? now,
    now,
    now,
  );
}

function insertTestEdge(
  db: SqliteDatabase,
  opts: {
    id: string;
    sourceNodeId: string;
    targetNodeId: string;
    relationType?: string;
    weight?: number;
  },
): void {
  db.prepare(
    `INSERT INTO knowledge_edges (id, source_node_id, target_node_id, relation_type, weight)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.sourceNodeId,
    opts.targetNodeId,
    opts.relationType ?? 'related_to',
    opts.weight ?? 1.0,
  );
}

// ── Float32 Serialization ───────────────────────────────────────────

describe('EmbeddingService float32 methods', () => {
  it('vectorToFloat32Blob produces correct buffer size', () => {
    const vec = [0.1, 0.2, 0.3, 0.4, 0.5];
    const blob = EmbeddingService.vectorToFloat32Blob(vec);
    // 5 floats * 4 bytes each = 20
    expect(blob.length).toBe(20);
  });

  it('float32 roundtrip preserves values within float32 precision', () => {
    const original = [1.5, -2.7, 0, 3.14, 0.001];
    const blob = EmbeddingService.vectorToFloat32Blob(original);
    const restored = EmbeddingService.float32BlobToVector(blob);

    expect(restored).toHaveLength(original.length);
    for (let i = 0; i < original.length; i++) {
      // Float32 has ~7 digits of precision
      expect(restored[i]).toBeCloseTo(original[i], 3);
    }
  });

  it('handles empty array for float32', () => {
    const blob = EmbeddingService.vectorToFloat32Blob([]);
    expect(blob.length).toBe(0);
    expect(EmbeddingService.float32BlobToVector(blob)).toEqual([]);
  });

  it('float32 blob is half the size of float64 blob', () => {
    const vec = [1, 2, 3, 4, 5];
    const f64 = EmbeddingService.vectorToBlob(vec);
    const f32 = EmbeddingService.vectorToFloat32Blob(vec);
    expect(f32.length).toBe(f64.length / 2);
  });
});

// ── sqlite-vec Utilities ────────────────────────────────────────────

describe('sqlite-vec utilities', () => {
  let db: SqliteDatabase;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('isVecTableAvailable returns false when table does not exist', () => {
    expect(isVecTableAvailable(db)).toBe(false);
  });

  it('tryInitVecTable returns false when vec0 extension is not loaded', () => {
    // In-memory DB without sqlite-vec extension -- vec0 module is unknown
    const result = tryInitVecTable(db);
    expect(result).toBe(false);
  });

  it('isVecTableAvailable returns false after failed tryInitVecTable', () => {
    tryInitVecTable(db);
    expect(isVecTableAvailable(db)).toBe(false);
  });
});

// ── HybridSearch Pipeline Stage ─────────────────────────────────────

describe('HybridSearch', () => {
  let db: SqliteDatabase;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('returns results from FTS search', async () => {
    insertTestNode(db, { id: 'n1', content: 'React is a JavaScript library' });
    insertTestNode(db, { id: 'n2', content: 'Python is a programming language' });

    const stage = new HybridSearch(db);

    const input: RetrievalPipelineData = {
      query: 'React',
      results: [],
    };

    const output = await stage.execute(input);
    expect(output).not.toBeNull();
    expect(output!.results.length).toBe(1);
    expect(output!.results[0].node.id).toBe('n1');
  });

  it('returns null for empty query', async () => {
    const stage = new HybridSearch(db);
    const output = await stage.execute({ query: '', results: [] });
    expect(output).toBeNull();
  });

  it('returns null for whitespace-only query', async () => {
    const stage = new HybridSearch(db);
    const output = await stage.execute({ query: '   ', results: [] });
    expect(output).toBeNull();
  });

  it('passes topic filter to search', async () => {
    insertTestNode(db, { id: 'n1', content: 'React decision', topic: 'decisions' });
    insertTestNode(db, { id: 'n2', content: 'React fact', topic: 'technical' });

    const stage = new HybridSearch(db);

    const output = await stage.execute({
      query: 'React',
      topic: 'decisions',
      results: [],
    });

    expect(output).not.toBeNull();
    expect(output!.results.length).toBe(1);
    expect(output!.results[0].node.topic).toBe('decisions');
  });

  it('passes limit to search', async () => {
    for (let i = 0; i < 5; i++) {
      insertTestNode(db, { id: `n${i}`, content: `Memory about testing ${i}` });
    }

    const stage = new HybridSearch(db);

    const output = await stage.execute({
      query: 'testing',
      limit: 2,
      results: [],
    });

    expect(output).not.toBeNull();
    expect(output!.results.length).toBe(2);
  });

  it('preserves input fields in output', async () => {
    insertTestNode(db, { id: 'n1', content: 'React library' });

    const stage = new HybridSearch(db);

    const output = await stage.execute({
      query: 'React',
      topic: 'technical',
      limit: 5,
      results: [],
    });

    expect(output).not.toBeNull();
    expect(output!.query).toBe('React');
    expect(output!.topic).toBe('technical');
    expect(output!.limit).toBe(5);
  });

  it('returns empty results for non-matching query', async () => {
    insertTestNode(db, { id: 'n1', content: 'React is a JavaScript library' });

    const stage = new HybridSearch(db);

    const output = await stage.execute({
      query: 'Kubernetes deployment',
      results: [],
    });

    expect(output).not.toBeNull();
    expect(output!.results.length).toBe(0);
  });

  it('excludes soft-deleted nodes from FTS results', async () => {
    insertTestNode(db, { id: 'n1', content: 'React is great' });
    // Soft-delete the node
    db.prepare(`UPDATE knowledge_nodes SET deleted_at = datetime('now') WHERE id = ?`).run('n1');

    const stage = new HybridSearch(db);

    const output = await stage.execute({
      query: 'React',
      results: [],
    });

    expect(output).not.toBeNull();
    expect(output!.results.length).toBe(0);
  });

  it('applies pin boost to pinned nodes', async () => {
    insertTestNode(db, { id: 'n1', content: 'React pinned knowledge', pinned: 1, importance: 0.5 });
    insertTestNode(db, { id: 'n2', content: 'React unpinned knowledge', pinned: 0, importance: 0.5 });

    const stage = new HybridSearch(db);

    const output = await stage.execute({
      query: 'React',
      results: [],
    });

    expect(output).not.toBeNull();
    expect(output!.results.length).toBe(2);
    const pinned = output!.results.find((r) => r.node.id === 'n1');
    const unpinned = output!.results.find((r) => r.node.id === 'n2');
    expect(pinned).toBeDefined();
    expect(unpinned).toBeDefined();
    // Pinned node should have a higher score due to pin boost
    expect(pinned!.score).toBeGreaterThan(unpinned!.score);
  });

  it('handles FTS query with special characters', async () => {
    insertTestNode(db, { id: 'n1', content: 'C++ programming language' });

    const stage = new HybridSearch(db);

    // Should not throw even with special chars
    const output = await stage.execute({
      query: 'C++',
      results: [],
    });

    expect(output).not.toBeNull();
  });

  it('returns results sorted by score descending', async () => {
    // Insert nodes with different importance values
    insertTestNode(db, { id: 'n1', content: 'React basics overview', importance: 0.3 });
    insertTestNode(db, { id: 'n2', content: 'React advanced patterns', importance: 0.9 });
    insertTestNode(db, { id: 'n3', content: 'React testing strategies', importance: 0.6 });

    const stage = new HybridSearch(db);

    const output = await stage.execute({
      query: 'React',
      results: [],
    });

    expect(output).not.toBeNull();
    expect(output!.results.length).toBe(3);
    // Verify scores are descending
    for (let i = 1; i < output!.results.length; i++) {
      expect(output!.results[i - 1].score).toBeGreaterThanOrEqual(output!.results[i].score);
    }
  });

  it('getNode returns a node by ID', () => {
    insertTestNode(db, { id: 'n1', content: 'Test content' });

    const stage = new HybridSearch(db);
    const node = stage.getNode('n1');
    expect(node).not.toBeNull();
    expect(node!.id).toBe('n1');
    expect(node!.content).toBe('Test content');
  });

  it('getNode returns null for non-existent node', () => {
    const stage = new HybridSearch(db);
    expect(stage.getNode('nonexistent')).toBeNull();
  });

  it('getNode returns null for soft-deleted node', () => {
    insertTestNode(db, { id: 'n1', content: 'Deleted content' });
    db.prepare(`UPDATE knowledge_nodes SET deleted_at = datetime('now') WHERE id = ?`).run('n1');

    const stage = new HybridSearch(db);
    expect(stage.getNode('n1')).toBeNull();
  });

  it('getPinnedNodes returns only pinned nodes', () => {
    insertTestNode(db, { id: 'n1', content: 'Pinned 1', pinned: 1 });
    insertTestNode(db, { id: 'n2', content: 'Not pinned', pinned: 0 });
    insertTestNode(db, { id: 'n3', content: 'Pinned 2', pinned: 1 });

    const stage = new HybridSearch(db);
    const pinned = stage.getPinnedNodes();
    expect(pinned).toHaveLength(2);
    expect(pinned.every((n) => n.pinned === true)).toBe(true);
  });

  it('getPinnedNodes filters by topic', () => {
    insertTestNode(db, { id: 'n1', content: 'Pinned tech', pinned: 1, topic: 'technical' });
    insertTestNode(db, { id: 'n2', content: 'Pinned decision', pinned: 1, topic: 'decisions' });

    const stage = new HybridSearch(db);
    const pinned = stage.getPinnedNodes('technical');
    expect(pinned).toHaveLength(1);
    expect(pinned[0].topic).toBe('technical');
  });
});

// ── HybridSearch vecAvailable ───────────────────────────────────────

describe('HybridSearch vecAvailable', () => {
  let db: SqliteDatabase;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('returns false when knowledge_vec table does not exist', () => {
    const stage = new HybridSearch(db);
    expect(stage.vecAvailable).toBe(false);
  });

  it('caches the vec availability check', () => {
    const stage = new HybridSearch(db);

    // First access caches
    const first = stage.vecAvailable;
    const second = stage.vecAvailable;
    expect(first).toBe(second);
    expect(first).toBe(false);
  });

  it('resetVecCache clears the cached value', () => {
    const stage = new HybridSearch(db);
    expect(stage.vecAvailable).toBe(false);

    stage.resetVecCache();
    // After reset, it re-checks (still false in test env)
    expect(stage.vecAvailable).toBe(false);
  });
});

// ── Graph BFS Expansion ─────────────────────────────────────────────

describe('HybridSearch graph BFS', () => {
  let db: SqliteDatabase;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('expands graph from FTS seed nodes', async () => {
    // Create a chain: n1 --related_to--> n2 --related_to--> n3
    insertTestNode(db, { id: 'n1', content: 'React framework knowledge' });
    insertTestNode(db, { id: 'n2', content: 'Component architecture' });
    insertTestNode(db, { id: 'n3', content: 'State management patterns' });

    insertTestEdge(db, { id: 'e1', sourceNodeId: 'n1', targetNodeId: 'n2', weight: 0.9 });
    insertTestEdge(db, { id: 'e2', sourceNodeId: 'n2', targetNodeId: 'n3', weight: 0.8 });

    const stage = new HybridSearch(db, {
      ftsEnabled: true,
      graphEnabled: true,
      graphMaxHops: 2,
      graphSkipThreshold: 1.0,
    });

    const output = await stage.execute({
      query: 'React',
      results: [],
    });

    expect(output).not.toBeNull();
    // Should find n1 via FTS, then n2 and n3 via graph expansion
    const nodeIds = output!.results.map((r) => r.node.id);
    expect(nodeIds).toContain('n1');
    expect(nodeIds).toContain('n2');
    // n3 should be found via 2-hop BFS
    expect(nodeIds).toContain('n3');
  });

  it('graph BFS respects maxHops limit', async () => {
    // Chain: n1 -> n2 -> n3 -> n4
    insertTestNode(db, { id: 'n1', content: 'React starting point' });
    insertTestNode(db, { id: 'n2', content: 'First hop neighbor' });
    insertTestNode(db, { id: 'n3', content: 'Second hop neighbor' });
    insertTestNode(db, { id: 'n4', content: 'Third hop neighbor' });

    insertTestEdge(db, { id: 'e1', sourceNodeId: 'n1', targetNodeId: 'n2' });
    insertTestEdge(db, { id: 'e2', sourceNodeId: 'n2', targetNodeId: 'n3' });
    insertTestEdge(db, { id: 'e3', sourceNodeId: 'n3', targetNodeId: 'n4' });

    const stage = new HybridSearch(db, {
      ftsEnabled: true,
      graphEnabled: true,
      graphMaxHops: 1,
      graphSkipThreshold: 1.0, // Only 1 hop
    });

    const output = await stage.execute({
      query: 'React',
      results: [],
    });

    expect(output).not.toBeNull();
    const nodeIds = output!.results.map((r) => r.node.id);
    expect(nodeIds).toContain('n1'); // FTS match
    expect(nodeIds).toContain('n2'); // 1-hop neighbor
    // n3 and n4 should NOT be reached with maxHops=1
    expect(nodeIds).not.toContain('n3');
    expect(nodeIds).not.toContain('n4');
  });

  it('graph BFS traverses bidirectional edges', async () => {
    // n1 has edge to n2, and n3 has edge pointing to n1
    insertTestNode(db, { id: 'n1', content: 'React central node' });
    insertTestNode(db, { id: 'n2', content: 'Forward neighbor' });
    insertTestNode(db, { id: 'n3', content: 'Reverse neighbor' });

    insertTestEdge(db, { id: 'e1', sourceNodeId: 'n1', targetNodeId: 'n2' });
    insertTestEdge(db, { id: 'e2', sourceNodeId: 'n3', targetNodeId: 'n1' });

    const stage = new HybridSearch(db, {
      ftsEnabled: true,
      graphEnabled: true,
      graphMaxHops: 1,
      graphSkipThreshold: 1.0,
    });

    const output = await stage.execute({
      query: 'React',
      results: [],
    });

    expect(output).not.toBeNull();
    const nodeIds = output!.results.map((r) => r.node.id);
    expect(nodeIds).toContain('n1');
    expect(nodeIds).toContain('n2'); // forward
    expect(nodeIds).toContain('n3'); // reverse
  });

  it('graph BFS does not include soft-deleted neighbors', async () => {
    insertTestNode(db, { id: 'n1', content: 'React active node' });
    insertTestNode(db, { id: 'n2', content: 'Deleted neighbor' });

    insertTestEdge(db, { id: 'e1', sourceNodeId: 'n1', targetNodeId: 'n2' });

    // Soft-delete n2
    db.prepare(`UPDATE knowledge_nodes SET deleted_at = datetime('now') WHERE id = ?`).run('n2');

    const stage = new HybridSearch(db, {
      ftsEnabled: true,
      graphEnabled: true,
      graphMaxHops: 1,
      graphSkipThreshold: 1.0,
    });

    const output = await stage.execute({
      query: 'React',
      results: [],
    });

    expect(output).not.toBeNull();
    const nodeIds = output!.results.map((r) => r.node.id);
    expect(nodeIds).toContain('n1');
    expect(nodeIds).not.toContain('n2');
  });

  it('graph source label is set to "graph" for expanded nodes', async () => {
    insertTestNode(db, { id: 'n1', content: 'React seed node' });
    insertTestNode(db, { id: 'n2', content: 'Graph neighbor' });

    insertTestEdge(db, { id: 'e1', sourceNodeId: 'n1', targetNodeId: 'n2' });

    const stage = new HybridSearch(db, {
      ftsEnabled: true,
      graphEnabled: true,
      graphMaxHops: 1,
      graphSkipThreshold: 1.0,
    });

    const output = await stage.execute({
      query: 'React',
      results: [],
    });

    expect(output).not.toBeNull();
    const graphResult = output!.results.find((r) => r.node.id === 'n2');
    expect(graphResult).toBeDefined();
    expect(graphResult!.source).toBe('graph');
  });
});

// ── Fusion (FTS + Graph combined) ───────────────────────────────────

describe('HybridSearch result fusion', () => {
  let db: SqliteDatabase;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('fuses scores when node appears in both FTS and graph', async () => {
    // n1 and n2 are both about React, n2 is also a neighbor of n1
    insertTestNode(db, { id: 'n1', content: 'React component design' });
    insertTestNode(db, { id: 'n2', content: 'React hooks usage' });

    insertTestEdge(db, { id: 'e1', sourceNodeId: 'n1', targetNodeId: 'n2', weight: 0.9 });

    const stage = new HybridSearch(db, {
      ftsEnabled: true,
      graphEnabled: true,
      graphMaxHops: 1,
      graphSkipThreshold: 1.0,
    });

    const output = await stage.execute({
      query: 'React',
      results: [],
    });

    expect(output).not.toBeNull();
    // n2 appears in both FTS and graph, so it gets a fused score
    expect(output!.results.length).toBe(2);
    const n2Result = output!.results.find((r) => r.node.id === 'n2');
    expect(n2Result).toBeDefined();
    // The node should have a score > 0
    expect(n2Result!.score).toBeGreaterThan(0);
  });

  it('all scores are in [0, 1] range', async () => {
    insertTestNode(db, { id: 'n1', content: 'React framework', importance: 1.0, pinned: 1 });
    insertTestNode(db, { id: 'n2', content: 'React testing', importance: 0.9 });

    insertTestEdge(db, { id: 'e1', sourceNodeId: 'n1', targetNodeId: 'n2', weight: 1.0 });

    const stage = new HybridSearch(db, {
      ftsEnabled: true,
      graphEnabled: true,
      graphSkipThreshold: 1.0,
    });

    const output = await stage.execute({
      query: 'React',
      results: [],
    });

    expect(output).not.toBeNull();
    for (const result of output!.results) {
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1.0);
    }
  });
});

// ── Direct search() method ──────────────────────────────────────────

describe('HybridSearch.search()', () => {
  let db: SqliteDatabase;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('search returns empty array for empty query', async () => {
    const stage = new HybridSearch(db);
    const results = await stage.search('');
    expect(results).toEqual([]);
  });

  it('search returns empty array for whitespace query', async () => {
    const stage = new HybridSearch(db);
    const results = await stage.search('  \t  ');
    expect(results).toEqual([]);
  });

  it('search respects limit option', async () => {
    for (let i = 0; i < 10; i++) {
      insertTestNode(db, { id: `n${i}`, content: `Memory about databases ${i}` });
    }

    const stage = new HybridSearch(db);
    const results = await stage.search('databases', { limit: 3 });
    expect(results.length).toBe(3);
  });

  it('search uses config retrievalLimit when no limit specified', async () => {
    for (let i = 0; i < 15; i++) {
      insertTestNode(db, { id: `n${i}`, content: `Memory about testing code ${i}` });
    }

    const stage = new HybridSearch(db, { retrievalLimit: 5 });
    const results = await stage.search('testing');
    expect(results.length).toBe(5);
  });

  it('search updates last_accessed on returned nodes', async () => {
    const oldDate = '2020-01-01T00:00:00.000Z';
    insertTestNode(db, { id: 'n1', content: 'React library', lastAccessed: oldDate });

    const stage = new HybridSearch(db);
    await stage.search('React');

    // Check that last_accessed was updated
    const row = db.prepare('SELECT last_accessed FROM knowledge_nodes WHERE id = ?').get('n1') as {
      last_accessed: string;
    };
    expect(row.last_accessed).not.toBe(oldDate);
  });

  it('FTS source label is "fts" for text-matched results', async () => {
    insertTestNode(db, { id: 'n1', content: 'TypeScript programming' });

    const stage = new HybridSearch(db);
    const results = await stage.search('TypeScript');

    expect(results.length).toBe(1);
    expect(results[0].source).toBe('fts');
  });
});
