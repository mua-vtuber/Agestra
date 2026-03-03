import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryFacade } from '../facade.js';
import type { KnowledgeNodeCreate } from '../types.js';

function createFacade(): MemoryFacade {
  return new MemoryFacade({ dbPath: ':memory:' });
}

function createNode(overrides?: Partial<KnowledgeNodeCreate>): KnowledgeNodeCreate {
  return {
    content: 'test content',
    nodeType: 'fact',
    topic: 'technical',
    importance: 0.5,
    source: 'auto',
    ...overrides,
  };
}

describe('addEdge', () => {
  let facade: MemoryFacade;

  beforeEach(() => {
    facade = createFacade();
    facade.initialize();
  });

  afterEach(() => {
    facade.close();
  });

  it('should create an edge and return its ID', () => {
    const sourceId = facade.store(createNode({ content: 'Source node content' }));
    const targetId = facade.store(createNode({ content: 'Target node content' }));

    const edgeId = facade.addEdge(sourceId, targetId, 'related_to');
    expect(edgeId).toBeTruthy();
    expect(typeof edgeId).toBe('string');
  });

  it('should persist the edge in the database', () => {
    const sourceId = facade.store(createNode({ content: 'Edge source' }));
    const targetId = facade.store(createNode({ content: 'Edge target' }));

    const edgeId = facade.addEdge(sourceId, targetId, 'depends_on', 0.8);

    const db = facade.getDatabase()!;
    const row = db
      .prepare('SELECT * FROM knowledge_edges WHERE id = ?')
      .get(edgeId) as {
      id: string;
      source_node_id: string;
      target_node_id: string;
      relation_type: string;
      weight: number;
      created_at: string;
    };

    expect(row).toBeDefined();
    expect(row.source_node_id).toBe(sourceId);
    expect(row.target_node_id).toBe(targetId);
    expect(row.relation_type).toBe('depends_on');
    expect(row.weight).toBe(0.8);
    expect(row.created_at).toBeTruthy();
  });

  it('should use default weight of 1.0 when not specified', () => {
    const sourceId = facade.store(createNode({ content: 'Default weight source' }));
    const targetId = facade.store(createNode({ content: 'Default weight target' }));

    const edgeId = facade.addEdge(sourceId, targetId, 'related_to');

    const db = facade.getDatabase()!;
    const row = db
      .prepare('SELECT weight FROM knowledge_edges WHERE id = ?')
      .get(edgeId) as { weight: number };

    expect(row.weight).toBe(1.0);
  });

  it('should allow querying edges by source node', () => {
    const sourceId = facade.store(createNode({ content: 'Hub node' }));
    const target1 = facade.store(createNode({ content: 'Spoke one' }));
    const target2 = facade.store(createNode({ content: 'Spoke two' }));

    facade.addEdge(sourceId, target1, 'related_to');
    facade.addEdge(sourceId, target2, 'supersedes');

    const db = facade.getDatabase()!;
    const rows = db
      .prepare('SELECT * FROM knowledge_edges WHERE source_node_id = ?')
      .all(sourceId) as Array<{ target_node_id: string; relation_type: string }>;

    expect(rows.length).toBe(2);
    const targetIds = rows.map((r) => r.target_node_id);
    expect(targetIds).toContain(target1);
    expect(targetIds).toContain(target2);
  });

  it('should support all relation types', () => {
    const sourceId = facade.store(createNode({ content: 'Relation source' }));
    const targetId = facade.store(createNode({ content: 'Relation target' }));

    const types = [
      'related_to',
      'contradicts',
      'supersedes',
      'depends_on',
      'merged_from',
      'derived_from',
    ] as const;

    for (const relType of types) {
      const edgeId = facade.addEdge(sourceId, targetId, relType);
      expect(edgeId).toBeTruthy();
    }

    const db = facade.getDatabase()!;
    const count = db
      .prepare('SELECT COUNT(*) as cnt FROM knowledge_edges WHERE source_node_id = ?')
      .get(sourceId) as { cnt: number };

    expect(count.cnt).toBe(types.length);
  });

  it('should throw when facade is not initialized', () => {
    const uninitFacade = createFacade();
    expect(() =>
      uninitFacade.addEdge('a', 'b', 'related_to'),
    ).toThrow('not initialized');
    uninitFacade.close();
  });
});
