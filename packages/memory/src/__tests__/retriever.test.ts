import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MemoryRetriever } from '../retriever.js';

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

/** Insert a node directly into the DB for testing. */
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
    lastAccessed?: string;
    dedupeKey?: string;
    deletedAt?: string | null;
  },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO knowledge_nodes
     (id, content, node_type, topic, importance, source, pinned,
      last_accessed, created_at, updated_at, dedupe_key, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.content,
    opts.nodeType ?? 'fact',
    opts.topic ?? 'technical',
    opts.importance ?? 0.5,
    opts.source ?? 'auto',
    opts.pinned ?? 0,
    opts.lastAccessed ?? now,
    now,
    now,
    opts.dedupeKey ?? null,
    opts.deletedAt ?? null,
  );
}

// -- MemoryRetriever Tests --

describe('MemoryRetriever', () => {
  let db: Database.Database;
  let retriever: MemoryRetriever;

  beforeEach(() => {
    db = createTestDb();
    retriever = new MemoryRetriever(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns empty results for empty query', async () => {
    expect(await retriever.search('')).toEqual([]);
    expect(await retriever.search('  ')).toEqual([]);
  });

  it('returns empty results when no nodes exist', async () => {
    const results = await retriever.search('test query');
    expect(results).toEqual([]);
  });

  it('finds matching nodes by FTS5 search', async () => {
    insertTestNode(db, { id: 'n1', content: 'React is a JavaScript framework' });
    insertTestNode(db, { id: 'n2', content: 'Python is a programming language' });

    const results = await retriever.search('React');
    expect(results.length).toBe(1);
    expect(results[0].node.id).toBe('n1');
    expect(results[0].source).toBe('fts');
  });

  it('returns multiple matching results', async () => {
    insertTestNode(db, { id: 'n1', content: 'TypeScript supports type checking' });
    insertTestNode(db, { id: 'n2', content: 'TypeScript is a superset of JavaScript' });
    insertTestNode(db, { id: 'n3', content: 'Python has no type checking by default' });

    const results = await retriever.search('TypeScript');
    expect(results.length).toBe(2);
  });

  it('filters by topic when specified', async () => {
    insertTestNode(db, { id: 'n1', content: 'React framework decision', topic: 'decisions' });
    insertTestNode(db, { id: 'n2', content: 'React is popular', topic: 'technical' });

    const results = await retriever.search('React', { topic: 'decisions' });
    expect(results.length).toBe(1);
    expect(results[0].node.topic).toBe('decisions');
  });

  it('excludes soft-deleted nodes', async () => {
    insertTestNode(db, { id: 'n1', content: 'Active node about databases' });
    insertTestNode(db, { id: 'n2', content: 'Deleted node about databases', deletedAt: new Date().toISOString() });

    const results = await retriever.search('databases');
    expect(results.length).toBe(1);
    expect(results[0].node.id).toBe('n1');
  });

  it('respects limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      insertTestNode(db, { id: `n${i}`, content: `Memory about testing topic ${i}` });
    }

    const results = await retriever.search('testing', { limit: 2 });
    expect(results.length).toBe(2);
  });

  it('boosts pinned nodes', async () => {
    // Use identical content structure so FTS ranks are similar,
    // ensuring the pin boost is the differentiating factor.
    insertTestNode(db, { id: 'n1', content: 'architecture design patterns overview', pinned: 1, importance: 0.5 });
    insertTestNode(db, { id: 'n2', content: 'architecture design patterns overview', pinned: 0, importance: 0.5 });
    insertTestNode(db, { id: 'n3', content: 'architecture design patterns summary', pinned: 0, importance: 0.5 });

    const results = await retriever.search('architecture design patterns');
    expect(results.length).toBe(3);

    const pinnedResult = results.find((r) => r.node.id === 'n1');
    const regularResult = results.find((r) => r.node.id === 'n2');
    expect(pinnedResult).toBeDefined();
    expect(regularResult).toBeDefined();
    if (pinnedResult && regularResult) {
      // Pinned node gets a 1.2x boost, so its score should be higher
      expect(pinnedResult.score).toBeGreaterThan(regularResult.score);
    }
  });

  it('updates last_accessed on retrieval', async () => {
    const oldDate = '2020-01-01T00:00:00.000Z';
    insertTestNode(db, { id: 'n1', content: 'Something about deployment', lastAccessed: oldDate });

    await retriever.search('deployment');

    const row = db.prepare('SELECT last_accessed FROM knowledge_nodes WHERE id = ?').get('n1') as { last_accessed: string };
    expect(row.last_accessed).not.toBe(oldDate);
  });

  it('getNode returns a node by ID', () => {
    insertTestNode(db, { id: 'n1', content: 'Test node' });
    const node = retriever.getNode('n1');
    expect(node).not.toBeNull();
    expect(node?.content).toBe('Test node');
  });

  it('getNode returns null for non-existent ID', () => {
    expect(retriever.getNode('nonexistent')).toBeNull();
  });

  it('getNode returns null for soft-deleted node', () => {
    insertTestNode(db, { id: 'n1', content: 'Deleted', deletedAt: new Date().toISOString() });
    expect(retriever.getNode('n1')).toBeNull();
  });

  it('getPinnedNodes returns only pinned nodes', () => {
    insertTestNode(db, { id: 'n1', content: 'Pinned', pinned: 1 });
    insertTestNode(db, { id: 'n2', content: 'Not pinned', pinned: 0 });

    const pinned = retriever.getPinnedNodes();
    expect(pinned.length).toBe(1);
    expect(pinned[0].id).toBe('n1');
  });

  it('getPinnedNodes filters by topic', () => {
    insertTestNode(db, { id: 'n1', content: 'Tech pin', pinned: 1, topic: 'technical' });
    insertTestNode(db, { id: 'n2', content: 'Decision pin', pinned: 1, topic: 'decisions' });

    const results = retriever.getPinnedNodes('technical');
    expect(results.length).toBe(1);
    expect(results[0].topic).toBe('technical');
  });

  it('handles FTS5 special characters gracefully', async () => {
    insertTestNode(db, { id: 'n1', content: 'Test with special chars' });

    // These should not throw
    await expect(retriever.search('test AND OR NOT')).resolves.toBeDefined();
    await expect(retriever.search('"quoted"')).resolves.toBeDefined();
    await expect(retriever.search('test*')).resolves.toBeDefined();
  });

  it('exposes the underlying HybridSearch instance', () => {
    const hybridSearch = retriever.getHybridSearch();
    expect(hybridSearch).toBeDefined();
    expect(hybridSearch.name).toBe('HybridSearch');
  });

  it('vecAvailable returns false when no vec table exists', () => {
    expect(retriever.vecAvailable).toBe(false);
  });

  it('resetVecCache allows re-checking vec availability', () => {
    // First check caches the result
    expect(retriever.vecAvailable).toBe(false);
    // Reset and check again
    retriever.resetVecCache();
    expect(retriever.vecAvailable).toBe(false);
  });
});
