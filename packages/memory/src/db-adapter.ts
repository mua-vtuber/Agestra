/**
 * sql.js wrapper that exposes a better-sqlite3–compatible synchronous API.
 *
 * Downstream code can switch from `better-sqlite3` to this adapter with
 * minimal changes — the main difference is that construction is async
 * (use `SqliteDatabase.create(path)` instead of `new Database(path)`).
 */

import { initSqlJs, type Database as SqlJsDatabase } from 'fts5-sql-bundle';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ── PreparedStatement ─────────────────────────────────────────────────

export class PreparedStatement {
  constructor(
    private readonly db: SqlJsDatabase,
    private readonly sql: string,
  ) {}

  /** Execute INSERT / UPDATE / DELETE and return change metadata. */
  run(...params: unknown[]): { changes: number; lastInsertRowid: number } {
    const flat = params.length === 1 && Array.isArray(params[0])
      ? params[0]
      : params;

    this.db.run(this.sql, flat as unknown[]);

    const changes = this.db.getRowsModified();
    const rowidResult = this.db.exec('SELECT last_insert_rowid() AS rid');
    const lastInsertRowid =
      rowidResult.length > 0 && rowidResult[0].values.length > 0
        ? (rowidResult[0].values[0][0] as number)
        : 0;

    return { changes, lastInsertRowid };
  }

  /** Fetch a single row as a plain object, or `undefined` if none. */
  get(...params: unknown[]): unknown {
    const flat = params.length === 1 && Array.isArray(params[0])
      ? params[0]
      : params;

    const stmt = this.db.prepare(this.sql);
    try {
      stmt.bind(flat as unknown[]);
      if (!stmt.step()) {
        return undefined;
      }
      return stmt.getAsObject() as Record<string, unknown>;
    } finally {
      stmt.free();
    }
  }

  /** Fetch all matching rows as an array of plain objects. */
  all(...params: unknown[]): unknown[] {
    const flat = params.length === 1 && Array.isArray(params[0])
      ? params[0]
      : params;

    const stmt = this.db.prepare(this.sql);
    const rows: Record<string, unknown>[] = [];
    try {
      stmt.bind(flat as unknown[]);
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as Record<string, unknown>);
      }
      return rows;
    } finally {
      stmt.free();
    }
  }
}

// ── SqliteDatabase ────────────────────────────────────────────────────

export class SqliteDatabase {
  private db: SqlJsDatabase;
  private readonly filePath: string | null;

  private constructor(db: SqlJsDatabase, filePath: string | null) {
    this.db = db;
    this.filePath = filePath;
  }

  /**
   * Factory — use instead of `new Database(path)`.
   *
   * - `:memory:` → in-memory database
   * - file path  → persistent database (loaded from disk if it exists)
   */
  static async create(path: string): Promise<SqliteDatabase> {
    const SQL = await initSqlJs();

    const isMemory = path === ':memory:';
    let db: SqlJsDatabase;

    if (!isMemory && existsSync(path)) {
      const buffer = readFileSync(path);
      db = new SQL.Database(buffer);
    } else {
      db = new SQL.Database();
    }

    return new SqliteDatabase(db, isMemory ? null : path);
  }

  /** Execute raw SQL (typically DDL or multi-statement strings). */
  exec(sql: string): void {
    this.db.run(sql);
  }

  /** Return a prepared statement wrapper with `run`, `get`, `all`. */
  prepare(sql: string): PreparedStatement {
    return new PreparedStatement(this.db, sql);
  }

  /** Execute a PRAGMA statement. */
  pragma(str: string): void {
    this.db.run(`PRAGMA ${str}`);
  }

  /**
   * Wrap a function in a BEGIN / COMMIT transaction.
   * Returns a new function; the transaction runs when that function is called.
   * If the inner function throws, the transaction is rolled back and the
   * error is re-thrown.
   */
  transaction<T, A extends unknown[]>(fn: (...args: A) => T): (...args: A) => T {
    return (...args: A): T => {
      this.db.run('BEGIN');
      try {
        const result = fn(...args);
        this.db.run('COMMIT');
        return result;
      } catch (err) {
        this.db.run('ROLLBACK');
        throw err;
      }
    };
  }

  /** Save current state to file without closing the database. */
  flush(): void {
    if (this.filePath) {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const data = this.db.export();
      writeFileSync(this.filePath, Buffer.from(data));
    }
  }

  /** Save to file (if file-based) and close the database. */
  close(): void {
    this.flush();
    this.db.close();
  }
}
