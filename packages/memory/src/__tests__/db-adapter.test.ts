import { describe, it, expect, afterEach } from 'vitest';
import { SqliteDatabase } from '../db-adapter.js';
import { existsSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('SqliteDatabase', () => {
  let db: SqliteDatabase;

  afterEach(() => {
    try {
      db?.close();
    } catch {
      // already closed
    }
  });

  // ── Creation ──────────────────────────────────────────────────────

  it('should create an in-memory database', async () => {
    db = await SqliteDatabase.create(':memory:');
    expect(db).toBeInstanceOf(SqliteDatabase);
  });

  // ── exec ──────────────────────────────────────────────────────────

  it('should execute DDL via exec', async () => {
    db = await SqliteDatabase.create(':memory:');
    db.exec(`
      CREATE TABLE test (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL
      );
    `);
    // If no error, DDL succeeded. Verify by inserting.
    db.exec(`INSERT INTO test (name) VALUES ('hello')`);
    const row = db.prepare('SELECT name FROM test WHERE id = 1').get();
    expect(row).toEqual({ name: 'hello' });
  });

  // ── prepare + run ─────────────────────────────────────────────────

  it('should prepare and run INSERT, returning changes count', async () => {
    db = await SqliteDatabase.create(':memory:');
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, val TEXT)');

    const result = db.prepare('INSERT INTO items (val) VALUES (?)').run('alpha');
    expect(result.changes).toBe(1);
    expect(typeof result.lastInsertRowid).toBe('number');
    expect(result.lastInsertRowid).toBeGreaterThan(0);
  });

  // ── prepare + get ─────────────────────────────────────────────────

  it('should prepare and get a single row as an object', async () => {
    db = await SqliteDatabase.create(':memory:');
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, val TEXT)');
    db.prepare('INSERT INTO items (val) VALUES (?)').run('beta');

    const row = db.prepare('SELECT * FROM items WHERE val = ?').get('beta');
    expect(row).toBeDefined();
    expect(row).toEqual({ id: 1, val: 'beta' });
  });

  it('should return undefined for a missing row', async () => {
    db = await SqliteDatabase.create(':memory:');
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, val TEXT)');

    const row = db.prepare('SELECT * FROM items WHERE val = ?').get('nope');
    expect(row).toBeUndefined();
  });

  // ── prepare + all ─────────────────────────────────────────────────

  it('should prepare and all to fetch multiple rows', async () => {
    db = await SqliteDatabase.create(':memory:');
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, val TEXT)');
    db.prepare('INSERT INTO items (val) VALUES (?)').run('a');
    db.prepare('INSERT INTO items (val) VALUES (?)').run('b');
    db.prepare('INSERT INTO items (val) VALUES (?)').run('c');

    const rows = db.prepare('SELECT val FROM items ORDER BY val').all();
    expect(rows).toEqual([{ val: 'a' }, { val: 'b' }, { val: 'c' }]);
  });

  it('should support parameters in all()', async () => {
    db = await SqliteDatabase.create(':memory:');
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, val TEXT, score INTEGER)');
    db.prepare('INSERT INTO items (val, score) VALUES (?, ?)').run('x', 10);
    db.prepare('INSERT INTO items (val, score) VALUES (?, ?)').run('y', 20);
    db.prepare('INSERT INTO items (val, score) VALUES (?, ?)').run('z', 30);

    const rows = db
      .prepare('SELECT val FROM items WHERE score >= ? ORDER BY val')
      .all(20);
    expect(rows).toEqual([{ val: 'y' }, { val: 'z' }]);
  });

  // ── pragma ────────────────────────────────────────────────────────

  it('should execute pragma without error', async () => {
    db = await SqliteDatabase.create(':memory:');
    expect(() => db.pragma('journal_mode = WAL')).not.toThrow();
    expect(() => db.pragma('foreign_keys = ON')).not.toThrow();
  });

  // ── transaction ───────────────────────────────────────────────────

  it('should commit a successful transaction', async () => {
    db = await SqliteDatabase.create(':memory:');
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, val TEXT)');

    const insertThree = db.transaction(() => {
      db.prepare('INSERT INTO items (val) VALUES (?)').run('a');
      db.prepare('INSERT INTO items (val) VALUES (?)').run('b');
      db.prepare('INSERT INTO items (val) VALUES (?)').run('c');
    });

    insertThree();

    const rows = db.prepare('SELECT val FROM items ORDER BY val').all();
    expect(rows).toHaveLength(3);
  });

  it('should rollback a transaction on error', async () => {
    db = await SqliteDatabase.create(':memory:');
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, val TEXT)');

    const failing = db.transaction(() => {
      db.prepare('INSERT INTO items (val) VALUES (?)').run('a');
      throw new Error('deliberate failure');
    });

    expect(() => failing()).toThrow('deliberate failure');

    const rows = db.prepare('SELECT val FROM items').all();
    expect(rows).toHaveLength(0);
  });

  it('should support transactions with arguments', async () => {
    db = await SqliteDatabase.create(':memory:');
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, val TEXT)');

    const insertMany = db.transaction((values: string[]) => {
      for (const v of values) {
        db.prepare('INSERT INTO items (val) VALUES (?)').run(v);
      }
    });

    insertMany(['x', 'y', 'z']);

    const rows = db.prepare('SELECT val FROM items ORDER BY val').all();
    expect(rows).toEqual([{ val: 'x' }, { val: 'y' }, { val: 'z' }]);
  });

  // ── FTS5 support ──────────────────────────────────────────────────

  it('should support FTS5 virtual tables', async () => {
    db = await SqliteDatabase.create(':memory:');
    db.exec(`
      CREATE VIRTUAL TABLE docs USING fts5(title, body);
    `);
    db.prepare('INSERT INTO docs (title, body) VALUES (?, ?)').run(
      'TypeScript Guide',
      'TypeScript is a typed superset of JavaScript',
    );
    db.prepare('INSERT INTO docs (title, body) VALUES (?, ?)').run(
      'Python Guide',
      'Python is dynamically typed',
    );

    const results = db
      .prepare('SELECT title FROM docs WHERE docs MATCH ?')
      .all('typescript');
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ title: 'TypeScript Guide' });
  });

  // ── File-based persistence ────────────────────────────────────────

  it('should persist data to a file and reopen', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'sqlitedb-test-'));
    const dbPath = join(tmpDir, 'test.db');

    try {
      // Create and populate
      const db1 = await SqliteDatabase.create(dbPath);
      db1.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, val TEXT)');
      db1.prepare('INSERT INTO items (val) VALUES (?)').run('persisted');
      db1.close();

      expect(existsSync(dbPath)).toBe(true);

      // Reopen and verify
      const db2 = await SqliteDatabase.create(dbPath);
      const row = db2.prepare('SELECT val FROM items WHERE id = 1').get() as
        | { val: string }
        | undefined;
      expect(row).toBeDefined();
      expect(row!.val).toBe('persisted');
      db2.close();
    } finally {
      // Cleanup
      try {
        unlinkSync(dbPath);
      } catch {
        // ignore
      }
    }
  });

  // ── flush ─────────────────────────────────────────────────────────

  it('should flush data to file without closing', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'sqlitedb-flush-'));
    const dbPath = join(tmpDir, 'flush-test.db');

    try {
      db = await SqliteDatabase.create(dbPath);
      db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, val TEXT)');
      db.prepare('INSERT INTO items (val) VALUES (?)').run('flushed');
      db.flush();

      expect(existsSync(dbPath)).toBe(true);

      // Should still be usable after flush
      db.prepare('INSERT INTO items (val) VALUES (?)').run('after-flush');
      const rows = db.prepare('SELECT val FROM items ORDER BY id').all();
      expect(rows).toHaveLength(2);
    } finally {
      try {
        db?.close();
        unlinkSync(dbPath);
      } catch {
        // ignore
      }
    }
  });
});
