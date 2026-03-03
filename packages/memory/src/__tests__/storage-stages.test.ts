import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteDatabase } from '../db-adapter.js';
import { ProviderTagger, ReMentionDetector, ConflictChecker, StorageStage } from '../storage-stages.js';
import type { StoragePipelineData, EnrichedExtractionItem } from '../storage-stages.js';
import type { ExtractionItem } from '../types.js';
import type { AnnotatedMessage } from '../pipeline.js';

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

function makeItem(content: string, opts?: Partial<ExtractionItem>): EnrichedExtractionItem {
  return {
    content,
    nodeType: opts?.nodeType ?? 'fact',
    topic: opts?.topic ?? 'technical',
    importance: opts?.importance ?? 0.5,
    providerId: opts?.providerId,
    confidence: opts?.confidence ?? 0.5,
  };
}

function makeInput(items: EnrichedExtractionItem[], messages?: AnnotatedMessage[]): StoragePipelineData {
  return {
    items,
    messages: messages ?? [
      { content: 'Test message', providerId: 'ai-1' },
    ],
  };
}

// -- ProviderTagger --

describe('ProviderTagger', () => {
  const tagger = new ProviderTagger();

  it('passes through items that already have providerId', async () => {
    const input = makeInput([
      makeItem('React decision', { providerId: 'ai-1' }),
    ]);

    const result = await tagger.execute(input);
    expect(result.items[0].providerId).toBe('ai-1');
  });

  it('preserves all items', async () => {
    const input = makeInput([
      makeItem('Item 1', { providerId: 'ai-1' }),
      makeItem('Item 2', { providerId: 'ai-2' }),
    ]);

    const result = await tagger.execute(input);
    expect(result.items).toHaveLength(2);
  });
});

// -- ReMentionDetector --

describe('ReMentionDetector', () => {
  let db: SqliteDatabase;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('passes new items through when no existing nodes', async () => {
    const detector = new ReMentionDetector(db);
    const input = makeInput([makeItem('Brand new fact')]);

    const result = await detector.execute(input);
    expect(result).not.toBeNull();
    expect(result!.items).toHaveLength(1);
  });

  it('detects exact re-mention via dedupe key', async () => {
    // Insert existing node with matching dedupe_key
    const crypto = await import('node:crypto');
    const content = 'React를 사용하기로 결정';
    const normalized = content.trim().toLowerCase().replace(/\s+/g, ' ');
    const dedupeKey = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);

    db.prepare(
      `INSERT INTO knowledge_nodes (id, content, node_type, topic, importance, source, dedupe_key, mention_count)
       VALUES (?, ?, 'decision', 'technical', 0.7, 'auto', ?, 0)`,
    ).run('existing-1', content, dedupeKey);

    const detector = new ReMentionDetector(db);
    const input = makeInput([makeItem(content)]);

    const result = await detector.execute(input);

    // Should be null (all items were re-mentions)
    expect(result).toBeNull();

    // Check mention_count was updated
    const row = db.prepare('SELECT mention_count, last_mentioned_at FROM knowledge_nodes WHERE id = ?')
      .get('existing-1') as { mention_count: number; last_mentioned_at: string };
    expect(row.mention_count).toBe(1);
    expect(row.last_mentioned_at).toBeTruthy();
  });

  it('boosts importance on re-mention', async () => {
    const crypto = await import('node:crypto');
    const content = 'TypeScript decision';
    const normalized = content.trim().toLowerCase().replace(/\s+/g, ' ');
    const dedupeKey = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);

    db.prepare(
      `INSERT INTO knowledge_nodes (id, content, node_type, topic, importance, source, dedupe_key, mention_count)
       VALUES (?, ?, 'decision', 'technical', 0.5, 'auto', ?, 2)`,
    ).run('existing-2', content, dedupeKey);

    const detector = new ReMentionDetector(db);
    const input = makeInput([makeItem(content)]);
    await detector.execute(input);

    const row = db.prepare('SELECT importance FROM knowledge_nodes WHERE id = ?')
      .get('existing-2') as { importance: number };

    // importance should have increased
    expect(row.importance).toBeGreaterThan(0.5);
  });

  it('passes truly new items through', async () => {
    const detector = new ReMentionDetector(db);
    const input = makeInput([
      makeItem('Completely new fact about GraphQL'),
    ]);

    const result = await detector.execute(input);
    expect(result).not.toBeNull();
    expect(result!.items).toHaveLength(1);
    expect(result!.items[0].content).toContain('GraphQL');
  });
});

// -- ConflictChecker --

describe('ConflictChecker', () => {
  let db: SqliteDatabase;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('passes through non-decision items unchanged', async () => {
    const checker = new ConflictChecker(db);
    const input = makeInput([makeItem('Some fact', { nodeType: 'fact' })]);

    const result = await checker.execute(input);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]._conflictsWith).toBeUndefined();
  });

  it('detects conflicting decisions in same topic', async () => {
    // Existing decision about frontend framework
    db.prepare(
      `INSERT INTO knowledge_nodes (id, content, node_type, topic, importance, source)
       VALUES (?, ?, 'decision', 'technical', 0.7, 'auto')`,
    ).run('existing-react', '프론트엔드 프레임워크로 React를 사용하기로 결정');

    const checker = new ConflictChecker(db);
    const input = makeInput([
      makeItem('프론트엔드 프레임워크로 Vue를 사용하기로 결정', {
        nodeType: 'decision',
        topic: 'technical',
      }),
    ]);

    const result = await checker.execute(input);
    expect(result.items[0]._conflictsWith).toBe('existing-react');
  });

  it('does not flag non-conflicting decisions', async () => {
    db.prepare(
      `INSERT INTO knowledge_nodes (id, content, node_type, topic, importance, source)
       VALUES (?, ?, 'decision', 'technical', 0.7, 'auto')`,
    ).run('existing-db', 'Database로 SQLite를 사용');

    const checker = new ConflictChecker(db);
    const input = makeInput([
      makeItem('Frontend framework로 React를 사용', {
        nodeType: 'decision',
        topic: 'technical',
      }),
    ]);

    const result = await checker.execute(input);
    expect(result.items[0]._conflictsWith).toBeUndefined();
  });

  it('handles empty database gracefully', async () => {
    const checker = new ConflictChecker(db);
    const input = makeInput([
      makeItem('First ever decision', { nodeType: 'decision' }),
    ]);

    const result = await checker.execute(input);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]._conflictsWith).toBeUndefined();
  });
});

// -- StorageStage --

describe('StorageStage', () => {
  let db: SqliteDatabase;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('stores items in the database', async () => {
    const stage = new StorageStage(db);
    const input = makeInput([
      makeItem('React is our framework choice', { importance: 0.7 }),
      makeItem('TypeScript for type safety', { importance: 0.6 }),
    ]);

    const result = await stage.execute(input);
    expect(result.stored).toBe(2);
    expect(result.skipped).toBe(0);

    const rows = db.prepare('SELECT COUNT(*) as cnt FROM knowledge_nodes').get() as { cnt: number };
    expect(rows.cnt).toBe(2);
  });

  it('skips items below importance threshold', async () => {
    const stage = new StorageStage(db, { extractionMinImportance: 0.5 });
    const input = makeInput([
      makeItem('Important fact', { importance: 0.8 }),
      makeItem('Low importance item', { importance: 0.1 }),
    ]);

    const result = await stage.execute(input);
    expect(result.stored).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('deduplicates items with same content', async () => {
    const stage = new StorageStage(db);
    const input = makeInput([
      makeItem('Duplicate content here'),
      makeItem('Duplicate content here'),
    ]);

    const result = await stage.execute(input);
    expect(result.stored).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('stores provider_id and confidence', async () => {
    const stage = new StorageStage(db);
    const input = makeInput([
      makeItem('Fact from AI-1', { providerId: 'ai-1', confidence: 0.9 }),
    ]);

    await stage.execute(input);

    const row = db.prepare(
      'SELECT provider_id, confidence FROM knowledge_nodes LIMIT 1',
    ).get() as { provider_id: string; confidence: number };

    expect(row.provider_id).toBe('ai-1');
    expect(row.confidence).toBe(0.9);
  });

  it('creates conflict edges when _conflictsWith is set', async () => {
    // Insert an existing node to conflict with
    db.prepare(
      `INSERT INTO knowledge_nodes (id, content, node_type, topic, importance, source)
       VALUES (?, ?, 'decision', 'technical', 0.7, 'auto')`,
    ).run('existing-node', 'Use React for frontend');

    const stage = new StorageStage(db);
    const item = makeItem('Use Vue for frontend', { importance: 0.7 });
    item._conflictsWith = 'existing-node';
    const input = makeInput([item]);

    const result = await stage.execute(input);
    expect(result.stored).toBe(1);
    expect(result.conflicts).toBe(1);

    // Check edges were created
    const edges = db.prepare(
      'SELECT relation_type FROM knowledge_edges ORDER BY relation_type',
    ).all() as Array<{ relation_type: string }>;

    expect(edges).toHaveLength(2);
    expect(edges.map(e => e.relation_type).sort()).toEqual(['contradicts', 'supersedes']);
  });

  it('stores conversationId from pipeline data', async () => {
    const stage = new StorageStage(db);
    const input: StoragePipelineData = {
      items: [makeItem('Fact for conv-42', { importance: 0.6 })],
      messages: [{ content: 'test', providerId: 'ai-1' }],
      conversationId: 'conv-42',
    };

    await stage.execute(input);

    const row = db.prepare(
      'SELECT conversation_id FROM knowledge_nodes LIMIT 1',
    ).get() as { conversation_id: string };

    expect(row.conversation_id).toBe('conv-42');
  });
});
