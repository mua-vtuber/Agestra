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

describe('dead_end and finding node types', () => {
  let facade: MemoryFacade;

  beforeEach(async () => {
    facade = createFacade();
    await facade.initialize();
  });

  afterEach(() => {
    facade.close();
  });

  it('should store a dead_end node and retrieve it by ID', () => {
    const id = facade.store(
      createNode({
        content: 'Tried approach X but it caused memory leaks',
        nodeType: 'dead_end',
      }),
    );

    const node = facade.getNode(id);
    expect(node).not.toBeNull();
    expect(node!.nodeType).toBe('dead_end');
    expect(node!.content).toContain('memory leaks');
  });

  it('should store a finding node and retrieve it by ID', () => {
    const id = facade.store(
      createNode({
        content: 'Discovered that caching reduces latency by 40%',
        nodeType: 'finding',
      }),
    );

    const node = facade.getNode(id);
    expect(node).not.toBeNull();
    expect(node!.nodeType).toBe('finding');
  });

  it('should find a dead_end node via search', async () => {
    facade.store(
      createNode({
        content: 'Approach using polling caused high CPU usage',
        nodeType: 'dead_end',
      }),
    );

    const results = await facade.search('polling CPU');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].node.nodeType).toBe('dead_end');
  });

  it('should filter search results by nodeType', async () => {
    facade.store(
      createNode({
        content: 'WebSocket approach failed due to proxy limitations',
        nodeType: 'dead_end',
      }),
    );
    facade.store(
      createNode({
        content: 'WebSocket approach succeeded with SSE fallback',
        nodeType: 'finding',
      }),
    );

    const deadEndResults = await facade.search('WebSocket approach', {
      nodeType: 'dead_end',
    });
    expect(deadEndResults.length).toBe(1);
    expect(deadEndResults[0].node.nodeType).toBe('dead_end');

    const findingResults = await facade.search('WebSocket approach', {
      nodeType: 'finding',
    });
    expect(findingResults.length).toBe(1);
    expect(findingResults[0].node.nodeType).toBe('finding');
  });

  it('should return all types when nodeType filter is not specified', async () => {
    facade.store(
      createNode({
        content: 'GraphQL schema stitching caused N+1 issues',
        nodeType: 'dead_end',
      }),
    );
    facade.store(
      createNode({
        content: 'GraphQL schema federation resolved N+1 issues',
        nodeType: 'finding',
      }),
    );

    const allResults = await facade.search('GraphQL schema');
    expect(allResults.length).toBe(2);
  });
});
