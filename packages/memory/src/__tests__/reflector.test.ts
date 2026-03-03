import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ReflectionEngine } from '../reflector.js';
import type { ReflectionLlmFn } from '../reflector.js';
import { DEFAULT_MEMORY_CONFIG } from '../types.js';

// -- Helpers ----------------------------------------------------------------

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

/** Counter for generating unique IDs. */
let nodeCounter = 0;

/** Insert a test node directly into the DB. */
function insertTestNode(
  db: Database.Database,
  opts: {
    id?: string;
    content: string;
    nodeType?: string;
    topic?: string;
    importance?: number;
    source?: string;
    createdAt?: string;
  },
): string {
  const id = opts.id ?? `node-${++nodeCounter}`;
  const now = opts.createdAt ?? new Date().toISOString();

  db.prepare(
    `INSERT INTO knowledge_nodes
     (id, content, node_type, topic, importance, source, pinned,
      last_accessed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(
    id,
    opts.content,
    opts.nodeType ?? 'fact',
    opts.topic ?? 'technical',
    opts.importance ?? 0.5,
    opts.source ?? 'auto',
    now,
    now,
    now,
  );

  return id;
}

/** Create a mock LLM function that returns valid insight JSON. */
function createMockLlm(
  response?: string,
): ReflectionLlmFn {
  const defaultResponse = JSON.stringify([
    { content: 'Pattern detected: strong preference for TypeScript', importance: 0.8 },
    { content: 'Trend: increasing focus on type safety', importance: 0.7 },
  ]);

  return vi.fn<ReflectionLlmFn>().mockResolvedValue(response ?? defaultResponse);
}

// -- shouldReflect ----------------------------------------------------------

describe('ReflectionEngine.shouldReflect', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    nodeCounter = 0;
  });

  afterEach(() => {
    db.close();
  });

  it('returns false when no nodes exist', () => {
    const engine = new ReflectionEngine(db, createMockLlm(), {
      reflectionThreshold: 5,
    });
    expect(engine.shouldReflect()).toBe(false);
  });

  it('returns false when below threshold', () => {
    for (let i = 0; i < 3; i++) {
      insertTestNode(db, { content: `Fact number ${i}` });
    }

    const engine = new ReflectionEngine(db, createMockLlm(), {
      reflectionThreshold: 5,
    });
    expect(engine.shouldReflect()).toBe(false);
  });

  it('returns true when threshold is met', () => {
    for (let i = 0; i < 5; i++) {
      insertTestNode(db, { content: `Fact number ${i}` });
    }

    const engine = new ReflectionEngine(db, createMockLlm(), {
      reflectionThreshold: 5,
    });
    expect(engine.shouldReflect()).toBe(true);
  });

  it('excludes reflection nodes from the count', () => {
    // Insert 4 auto nodes + 1 reflection node = 4 non-reflection nodes
    for (let i = 0; i < 4; i++) {
      insertTestNode(db, { content: `Fact number ${i}`, source: 'auto' });
    }
    insertTestNode(db, {
      content: 'Previous insight',
      source: 'reflection',
      nodeType: 'insight',
    });

    const engine = new ReflectionEngine(db, createMockLlm(), {
      reflectionThreshold: 5,
    });
    expect(engine.shouldReflect()).toBe(false);
  });

  it('only counts nodes after last reflection', () => {
    // Insert a reflection node with a recent timestamp
    const recentTime = new Date().toISOString();
    insertTestNode(db, {
      content: 'Previous insight',
      source: 'reflection',
      nodeType: 'insight',
      createdAt: recentTime,
    });

    // Insert nodes BEFORE the reflection timestamp (they should not count)
    const oldTime = new Date(Date.now() - 10000).toISOString();
    for (let i = 0; i < 10; i++) {
      insertTestNode(db, {
        content: `Old fact ${i}`,
        source: 'auto',
        createdAt: oldTime,
      });
    }

    const engine = new ReflectionEngine(db, createMockLlm(), {
      reflectionThreshold: 5,
    });
    expect(engine.shouldReflect()).toBe(false);
  });
});

// -- parseInsights ----------------------------------------------------------

describe('ReflectionEngine.parseInsights', () => {
  it('parses valid JSON array', () => {
    const json = JSON.stringify([
      { content: 'Insight one', importance: 0.8 },
      { content: 'Insight two', importance: 0.6 },
    ]);

    const results = ReflectionEngine.parseInsights(json);
    expect(results).toHaveLength(2);
    expect(results[0].content).toBe('Insight one');
    expect(results[0].importance).toBe(0.8);
    expect(results[1].content).toBe('Insight two');
    expect(results[1].importance).toBe(0.6);
  });

  it('handles markdown code fences', () => {
    const raw = '```json\n[{"content": "Fenced insight", "importance": 0.9}]\n```';
    const results = ReflectionEngine.parseInsights(raw);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('Fenced insight');
    expect(results[0].importance).toBe(0.9);
  });

  it('handles plain code fences without language tag', () => {
    const raw = '```\n[{"content": "Plain fence", "importance": 0.7}]\n```';
    const results = ReflectionEngine.parseInsights(raw);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('Plain fence');
  });

  it('handles invalid JSON gracefully', () => {
    const results = ReflectionEngine.parseInsights('not valid json at all');
    expect(results).toEqual([]);
  });

  it('handles non-array JSON gracefully', () => {
    const results = ReflectionEngine.parseInsights('{"content": "not an array"}');
    expect(results).toEqual([]);
  });

  it('handles empty string', () => {
    const results = ReflectionEngine.parseInsights('');
    expect(results).toEqual([]);
  });

  it('clamps importance below 0.5 up to 0.5', () => {
    const json = JSON.stringify([
      { content: 'Low importance', importance: 0.1 },
    ]);

    const results = ReflectionEngine.parseInsights(json);
    expect(results).toHaveLength(1);
    expect(results[0].importance).toBe(0.5);
  });

  it('clamps importance above 1.0 down to 1.0', () => {
    const json = JSON.stringify([
      { content: 'High importance', importance: 1.5 },
    ]);

    const results = ReflectionEngine.parseInsights(json);
    expect(results).toHaveLength(1);
    expect(results[0].importance).toBe(1.0);
  });

  it('filters out items with empty content', () => {
    const json = JSON.stringify([
      { content: '', importance: 0.8 },
      { content: '   ', importance: 0.7 },
      { content: 'Valid insight', importance: 0.6 },
    ]);

    const results = ReflectionEngine.parseInsights(json);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('Valid insight');
  });

  it('defaults importance to 0.7 when missing', () => {
    const json = JSON.stringify([{ content: 'No importance field' }]);

    const results = ReflectionEngine.parseInsights(json);
    expect(results).toHaveLength(1);
    expect(results[0].importance).toBe(0.7);
  });

  it('skips non-object items in the array', () => {
    const json = JSON.stringify([
      'just a string',
      42,
      null,
      { content: 'Valid', importance: 0.8 },
    ]);

    const results = ReflectionEngine.parseInsights(json);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('Valid');
  });
});

// -- reflect ----------------------------------------------------------------

describe('ReflectionEngine.reflect', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    nodeCounter = 0;
  });

  afterEach(() => {
    db.close();
  });

  it('creates insight nodes from LLM response', async () => {
    // Insert enough nodes in one topic to trigger reflection
    for (let i = 0; i < 10; i++) {
      insertTestNode(db, {
        content: `TypeScript fact number ${i}`,
        topic: 'technical',
      });
    }

    const mockLlm = createMockLlm();
    const engine = new ReflectionEngine(db, mockLlm, {
      reflectionThreshold: 5,
    });

    const result = await engine.reflect();

    expect(result.insightsCreated).toBe(2);
    expect(result.nodesProcessed).toBe(10);

    // Verify insight nodes exist in DB
    const insights = db
      .prepare(
        `SELECT * FROM knowledge_nodes
         WHERE node_type = 'insight' AND source = 'reflection'
         AND deleted_at IS NULL`,
      )
      .all() as Array<{ id: string; content: string; topic: string; importance: number }>;

    expect(insights).toHaveLength(2);
    expect(insights[0].content).toBe(
      'Pattern detected: strong preference for TypeScript',
    );
    expect(insights[0].topic).toBe('technical');
    expect(insights[1].content).toBe(
      'Trend: increasing focus on type safety',
    );
  });

  it('creates derived_from edges', async () => {
    for (let i = 0; i < 5; i++) {
      insertTestNode(db, {
        content: `Decision fact ${i}`,
        topic: 'decisions',
      });
    }

    const mockLlm = createMockLlm(
      JSON.stringify([{ content: 'Single insight', importance: 0.8 }]),
    );
    const engine = new ReflectionEngine(db, mockLlm, {
      reflectionThreshold: 5,
    });

    await engine.reflect();

    const edges = db
      .prepare(
        `SELECT * FROM knowledge_edges WHERE relation_type = 'derived_from'`,
      )
      .all() as Array<{
        source_node_id: string;
        target_node_id: string;
        relation_type: string;
        weight: number;
      }>;

    // 1 insight derived from 5 source nodes = 5 edges
    expect(edges).toHaveLength(5);
    expect(edges[0].relation_type).toBe('derived_from');
    expect(edges[0].weight).toBe(0.8);

    // All edges should reference the same insight node
    const insightIds = new Set(edges.map((e) => e.source_node_id));
    expect(insightIds.size).toBe(1);

    // All source nodes should be referenced
    const targetIds = new Set(edges.map((e) => e.target_node_id));
    expect(targetIds.size).toBe(5);
  });

  it('syncs FTS index so insights are searchable', async () => {
    for (let i = 0; i < 5; i++) {
      insertTestNode(db, {
        content: `Preference item ${i}`,
        topic: 'preferences',
      });
    }

    const mockLlm = createMockLlm(
      JSON.stringify([
        { content: 'Strong TypeScript preference detected', importance: 0.8 },
      ]),
    );
    const engine = new ReflectionEngine(db, mockLlm, {
      reflectionThreshold: 5,
    });

    await engine.reflect();

    // Verify the insight is searchable via FTS5
    const ftsResults = db
      .prepare(
        `SELECT kn.content
         FROM knowledge_fts kf
         JOIN knowledge_nodes kn ON kn.rowid = kf.rowid
         WHERE knowledge_fts MATCH '"TypeScript"'
           AND kn.source = 'reflection'`,
      )
      .all() as Array<{ content: string }>;

    expect(ftsResults).toHaveLength(1);
    expect(ftsResults[0].content).toContain('TypeScript');
  });

  it('returns zero when not enough nodes', async () => {
    // Insert only 2 nodes, below threshold
    insertTestNode(db, { content: 'Fact one', topic: 'technical' });
    insertTestNode(db, { content: 'Fact two', topic: 'technical' });

    const mockLlm = createMockLlm();
    const engine = new ReflectionEngine(db, mockLlm, {
      reflectionThreshold: 5,
    });

    const result = await engine.reflect();

    expect(result.insightsCreated).toBe(0);
    expect(result.nodesProcessed).toBe(0);
    expect(mockLlm).not.toHaveBeenCalled();
  });

  it('skips topic groups with fewer than 3 nodes', async () => {
    // 2 in 'technical', 5 in 'decisions' -- only decisions should be processed
    insertTestNode(db, { content: 'Tech fact 1', topic: 'technical' });
    insertTestNode(db, { content: 'Tech fact 2', topic: 'technical' });
    for (let i = 0; i < 5; i++) {
      insertTestNode(db, {
        content: `Decision fact ${i}`,
        topic: 'decisions',
      });
    }

    const mockLlm = createMockLlm(
      JSON.stringify([{ content: 'Decision pattern', importance: 0.8 }]),
    );
    const engine = new ReflectionEngine(db, mockLlm, {
      reflectionThreshold: 7,
    });

    const result = await engine.reflect();

    // LLM should be called only once (for decisions group)
    expect(mockLlm).toHaveBeenCalledTimes(1);
    expect(result.insightsCreated).toBe(1);
    expect(result.nodesProcessed).toBe(7);
  });

  it('handles LLM error gracefully', async () => {
    for (let i = 0; i < 5; i++) {
      insertTestNode(db, {
        content: `Error test fact ${i}`,
        topic: 'technical',
      });
    }

    const failingLlm = vi
      .fn<ReflectionLlmFn>()
      .mockRejectedValue(new Error('LLM service unavailable'));

    const engine = new ReflectionEngine(db, failingLlm, {
      reflectionThreshold: 5,
    });

    const result = await engine.reflect();

    expect(result.insightsCreated).toBe(0);
    expect(result.nodesProcessed).toBe(5);

    // No insight nodes should have been created
    const insights = db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM knowledge_nodes
         WHERE source = 'reflection'`,
      )
      .get() as { cnt: number };

    expect(insights.cnt).toBe(0);
  });

  it('handles LLM returning invalid JSON gracefully', async () => {
    for (let i = 0; i < 5; i++) {
      insertTestNode(db, {
        content: `Parse test fact ${i}`,
        topic: 'technical',
      });
    }

    const badJsonLlm = createMockLlm('This is not valid JSON at all');
    const engine = new ReflectionEngine(db, badJsonLlm, {
      reflectionThreshold: 5,
    });

    const result = await engine.reflect();

    expect(result.insightsCreated).toBe(0);
    expect(result.nodesProcessed).toBe(5);
  });

  it('processes multiple topic groups independently', async () => {
    for (let i = 0; i < 4; i++) {
      insertTestNode(db, {
        content: `Technical item ${i}`,
        topic: 'technical',
      });
    }
    for (let i = 0; i < 4; i++) {
      insertTestNode(db, {
        content: `Decision item ${i}`,
        topic: 'decisions',
      });
    }

    const mockLlm = vi.fn<ReflectionLlmFn>().mockResolvedValue(
      JSON.stringify([{ content: 'Group insight', importance: 0.75 }]),
    );

    const engine = new ReflectionEngine(db, mockLlm, {
      reflectionThreshold: 8,
    });

    const result = await engine.reflect();

    // LLM called once per topic group (2 groups with >= 3 nodes each)
    expect(mockLlm).toHaveBeenCalledTimes(2);
    expect(result.insightsCreated).toBe(2);
    expect(result.nodesProcessed).toBe(8);
  });

  it('uses default reflectionThreshold from config', async () => {
    // Default threshold is 10
    for (let i = 0; i < DEFAULT_MEMORY_CONFIG.reflectionThreshold; i++) {
      insertTestNode(db, {
        content: `Default threshold fact ${i}`,
        topic: 'technical',
      });
    }

    const mockLlm = createMockLlm();
    const engine = new ReflectionEngine(db, mockLlm);

    const result = await engine.reflect();

    expect(result.insightsCreated).toBeGreaterThan(0);
    expect(result.nodesProcessed).toBe(
      DEFAULT_MEMORY_CONFIG.reflectionThreshold,
    );
  });
});
