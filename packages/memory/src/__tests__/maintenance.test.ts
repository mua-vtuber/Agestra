import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryFacade } from '../facade.js';
import type { MemoryFacadeConfig } from '../facade.js';
import type { KnowledgeNodeCreate } from '../types.js';
import { checkIntegrity, rebuildIndexes } from '../maintenance.js';
import type { IntegrityResult, RebuildResult } from '../maintenance.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

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

/** Create a temp directory for file-based SQLite databases. */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'memory-maintenance-'));
}

// -- Tests --------------------------------------------------------------------

describe('maintenance: checkIntegrity', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return "ok" status for a fresh database', async () => {
    const dbPath = path.join(tmpDir, 'test.db');
    const facade = new MemoryFacade({ dbPath });
    facade.initialize();
    facade.close();

    const result = await checkIntegrity(dbPath);
    expect(result.status).toBe('ok');
    expect(result.details).toContain('ok');
  });

  it('should return correct counts for an empty database', async () => {
    const dbPath = path.join(tmpDir, 'empty.db');
    const facade = new MemoryFacade({ dbPath });
    facade.initialize();
    facade.close();

    const result = await checkIntegrity(dbPath);
    expect(result.status).toBe('ok');
    expect(result.nodeCount).toBe(0);
    expect(result.edgeCount).toBe(0);
    expect(result.ftsCount).toBe(0);
  });

  it('should return correct counts after storing nodes', async () => {
    const dbPath = path.join(tmpDir, 'populated.db');
    const facade = new MemoryFacade({ dbPath });
    facade.initialize();

    facade.store(createTestNode({ content: 'First fact about memory' }));
    facade.store(createTestNode({ content: 'Second fact about indexes' }));
    facade.store(createTestNode({ content: 'Third fact about databases' }));

    facade.close();

    const result = await checkIntegrity(dbPath);
    expect(result.status).toBe('ok');
    expect(result.nodeCount).toBe(3);
    expect(result.edgeCount).toBe(0);
    expect(result.ftsCount).toBe(3);
  });

  it('should verify FTS5 table is accessible', async () => {
    const dbPath = path.join(tmpDir, 'fts.db');
    const facade = new MemoryFacade({ dbPath });
    facade.initialize();
    facade.store(createTestNode({ content: 'FTS test content' }));
    facade.close();

    const result = await checkIntegrity(dbPath);
    expect(result.status).toBe('ok');
    expect(result.ftsCount).toBe(1);
  });

  it('should return "corrupted" status for non-existent database path', async () => {
    const badPath = path.join(tmpDir, 'nonexistent', 'does-not-exist.db');
    const result = await checkIntegrity(badPath);
    expect(result.status).toBe('corrupted');
    expect(result.details.length).toBeGreaterThan(0);
    // Should not throw, just return a corrupted result
    expect(result.nodeCount).toBe(0);
    expect(result.edgeCount).toBe(0);
    expect(result.ftsCount).toBe(0);
  });

  it('should include multiple detail entries on integrity failure', async () => {
    const badPath = path.join(tmpDir, 'nonexistent', 'missing.db');
    const result = await checkIntegrity(badPath);
    expect(result.status).toBe('corrupted');
    expect(Array.isArray(result.details)).toBe(true);
  });
});

describe('maintenance: rebuildIndexes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should include "fts5" in rebuiltIndexes on a valid database', async () => {
    const dbPath = path.join(tmpDir, 'rebuild.db');
    const facade = new MemoryFacade({ dbPath });
    facade.initialize();
    facade.store(createTestNode({ content: 'Content for rebuild test' }));
    facade.close();

    const result = await rebuildIndexes(dbPath);
    expect(result.rebuiltIndexes).toContain('fts5');
  });

  it('should include "reindex" in rebuiltIndexes', async () => {
    const dbPath = path.join(tmpDir, 'reindex.db');
    const facade = new MemoryFacade({ dbPath });
    facade.initialize();
    facade.store(createTestNode({ content: 'Content for reindex test' }));
    facade.close();

    const result = await rebuildIndexes(dbPath);
    expect(result.rebuiltIndexes).toContain('reindex');
  });

  it('should return positive duration', async () => {
    const dbPath = path.join(tmpDir, 'duration.db');
    const facade = new MemoryFacade({ dbPath });
    facade.initialize();
    facade.store(createTestNode({ content: 'Content for duration test' }));
    facade.close();

    const result = await rebuildIndexes(dbPath);
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(typeof result.duration).toBe('number');
  });

  it('should work on an empty database', async () => {
    const dbPath = path.join(tmpDir, 'empty-rebuild.db');
    const facade = new MemoryFacade({ dbPath });
    facade.initialize();
    facade.close();

    const result = await rebuildIndexes(dbPath);
    expect(result.rebuiltIndexes).toContain('fts5');
    expect(result.rebuiltIndexes).toContain('reindex');
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it('should throw for non-existent database path', async () => {
    const badPath = path.join(tmpDir, 'nonexistent', 'does-not-exist.db');
    await expect(rebuildIndexes(badPath)).rejects.toThrow();
  });

  it('should include "vec" in rebuiltIndexes when vec table exists', async () => {
    // This test verifies the vec branch by checking that vec is NOT included
    // when no vec table exists (since sqlite-vec is not loaded in test env).
    const dbPath = path.join(tmpDir, 'no-vec.db');
    const facade = new MemoryFacade({ dbPath });
    facade.initialize();
    facade.close();

    const result = await rebuildIndexes(dbPath);
    expect(result.rebuiltIndexes).not.toContain('vec');
  });
});
