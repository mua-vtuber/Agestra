/**
 * Maintenance utilities for the memory SQLite database.
 *
 * Provides integrity checks (PRAGMA integrity_check, row counts, FTS5
 * accessibility) and index rebuild (FTS5 rebuild, REINDEX, optional
 * sqlite-vec rebuild).
 *
 * All functions accept a file-system dbPath and open their own
 * connection, so they can be run as standalone health checks
 * without requiring a fully initialized MemoryFacade.
 */

import { SqliteDatabase } from './db-adapter.js';
import { isVecTableAvailable } from './hybrid-search.js';

// ── Result Types ────────────────────────────────────────────────────

/** Result of a database integrity check. */
export interface IntegrityResult {
  status: 'ok' | 'corrupted';
  details: string[];
  nodeCount: number;
  edgeCount: number;
  ftsCount: number;
}

/** Result of an index rebuild operation. */
export interface RebuildResult {
  rebuiltIndexes: string[];
  duration: number; // ms
}

// ── checkIntegrity ──────────────────────────────────────────────────

/**
 * Run a health check on the memory database.
 *
 * Opens a read-only connection, runs `PRAGMA integrity_check`,
 * counts rows in the core tables, and verifies FTS5 accessibility.
 *
 * Returns a structured result; never throws. A database that cannot
 * be opened at all is reported as `status: "corrupted"`.
 */
export async function checkIntegrity(dbPath: string): Promise<IntegrityResult> {
  let db: SqliteDatabase | null = null;

  try {
    db = await SqliteDatabase.create(dbPath);

    // 1. Run PRAGMA integrity_check
    const integrityRows = db.prepare('PRAGMA integrity_check').all() as Array<{
      integrity_check: string;
    }>;
    const details = integrityRows.map((r) => r.integrity_check);
    const isOk = details.length === 1 && details[0] === 'ok';

    // 2. Count rows in each table
    const nodeCount = countRows(db, 'knowledge_nodes');
    const edgeCount = countRows(db, 'knowledge_edges');

    // 3. Verify FTS5 table is accessible and count entries
    let ftsCount = 0;
    try {
      const ftsRow = db
        .prepare('SELECT COUNT(*) AS cnt FROM knowledge_fts')
        .get() as { cnt: number } | undefined;
      ftsCount = ftsRow?.cnt ?? 0;
    } catch {
      // FTS5 table may not exist or be corrupted
      if (isOk) {
        details.push('FTS5 table knowledge_fts is inaccessible');
      }
    }

    return {
      status: isOk ? 'ok' : 'corrupted',
      details,
      nodeCount,
      edgeCount,
      ftsCount,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'corrupted',
      details: [message],
      nodeCount: 0,
      edgeCount: 0,
      ftsCount: 0,
    };
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close errors
    }
  }
}

// ── rebuildIndexes ──────────────────────────────────────────────────

/**
 * Rebuild all indexes in the memory database.
 *
 * - Rebuilds the FTS5 index (knowledge_fts)
 * - Runs REINDEX for all regular B-tree indexes
 * - If sqlite-vec knowledge_vec table exists, drops and recreates it
 *
 * Returns the list of rebuilt index categories and total duration.
 * Throws if the database cannot be opened.
 */
export async function rebuildIndexes(dbPath: string): Promise<RebuildResult> {
  const start = performance.now();
  const rebuiltIndexes: string[] = [];

  const db = await SqliteDatabase.create(dbPath);

  try {
    // 1. Rebuild FTS5 index
    try {
      db.exec("INSERT INTO knowledge_fts(knowledge_fts) VALUES('rebuild')");
      rebuiltIndexes.push('fts5');
    } catch {
      // FTS5 table may not exist; skip silently
    }

    // 2. Rebuild regular indexes
    db.exec('REINDEX');
    rebuiltIndexes.push('reindex');

    // 3. If sqlite-vec knowledge_vec table exists, rebuild it
    if (isVecTableAvailable(db)) {
      try {
        // Read current dimension from table info
        // Drop and recreate with synced data
        rebuildVecIndex(db);
        rebuiltIndexes.push('vec');
      } catch {
        // Vec rebuild failed; skip silently
      }
    }

    const duration = performance.now() - start;
    return { rebuiltIndexes, duration };
  } finally {
    try {
      db.close();
    } catch {
      // Ignore close errors
    }
  }
}

// ── Private Helpers ─────────────────────────────────────────────────

/**
 * Count rows in a table. Returns 0 if the table doesn't exist.
 */
function countRows(db: SqliteDatabase, tableName: string): number {
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS cnt FROM ${tableName}`)
      .get() as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Rebuild the sqlite-vec knowledge_vec index by clearing and
 * re-inserting all embeddings from knowledge_nodes.
 */
function rebuildVecIndex(db: SqliteDatabase): void {
  // Read all node embeddings
  const nodes = db
    .prepare(
      `SELECT id, embedding FROM knowledge_nodes
       WHERE embedding IS NOT NULL AND deleted_at IS NULL`,
    )
    .all() as Array<{ id: string; embedding: Buffer }>;

  // Clear existing vec data
  db.exec('DELETE FROM knowledge_vec');

  // Re-insert
  const insertStmt = db.prepare(
    'INSERT INTO knowledge_vec (node_id, embedding) VALUES (?, ?)',
  );

  const insertAll = db.transaction(() => {
    for (const node of nodes) {
      // Convert the stored float64 BLOB to float32 for vec0
      const float64 = new Float64Array(
        node.embedding.buffer,
        node.embedding.byteOffset,
        node.embedding.byteLength / 8,
      );
      const float32 = new Float32Array(float64);
      insertStmt.run(node.id, Buffer.from(float32.buffer));
    }
  });

  insertAll();
}
