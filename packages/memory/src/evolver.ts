/**
 * Memory evolution: merge similar nodes and prune stale ones.
 *
 * Phase 3-b structural evolution operations inspired by A-MEM.
 *
 * Merge: When two nodes exceed the cosine similarity threshold, keep
 * the higher-importance one, soft-delete the other, and record a
 * `merged_from` edge for provenance.
 *
 * Prune: Nodes with low importance, not pinned, and age exceeding
 * 2x the configured recency half-life are soft-deleted.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { MemoryConfig, EvolutionResult } from './types.js';
import { DEFAULT_MEMORY_CONFIG } from './types.js';
import { EmbeddingService } from './embedding-service.js';

/** Raw row from knowledge_nodes with embedding blob. */
interface EmbeddingRow {
  id: string;
  importance: number;
  embedding: Buffer;
}

/** Raw row for prune candidates. */
interface PruneCandidateRow {
  id: string;
  importance: number;
  pinned: number;
  created_at: string;
}

/**
 * Structural memory evolution: merge duplicates and prune stale nodes.
 */
export class MemoryEvolver {
  private readonly db: Database.Database;
  private readonly embeddingService: EmbeddingService;
  private readonly config: MemoryConfig;

  constructor(
    db: Database.Database,
    embeddingService: EmbeddingService,
    config?: Partial<MemoryConfig>,
  ) {
    this.db = db;
    this.embeddingService = embeddingService;
    this.config = { ...DEFAULT_MEMORY_CONFIG, ...config };
  }

  /**
   * Run all evolution operations: merge similar nodes, then prune stale ones.
   *
   * @returns Counts of merged and pruned nodes.
   */
  evolve(): EvolutionResult {
    const merged = this.mergeSimilar();
    const pruned = this.pruneStale();
    return { merged, pruned };
  }

  // -- Merge Similar --------------------------------------------------------

  /**
   * Merge nodes with high cosine similarity.
   *
   * For each pair of non-deleted nodes with embeddings, compute cosine
   * similarity. When it exceeds the threshold, keep the node with higher
   * importance, soft-delete the other, and create a `merged_from` edge.
   *
   * @returns Number of nodes merged (soft-deleted).
   */
  private mergeSimilar(): number {
    if (!this.embeddingService.available) {
      return 0;
    }

    const candidates = this.db
      .prepare(
        `SELECT id, importance, embedding
         FROM knowledge_nodes
         WHERE embedding IS NOT NULL
           AND deleted_at IS NULL
         LIMIT ?`,
      )
      .all(this.config.mergeMaxCandidates) as EmbeddingRow[];

    if (candidates.length < 2) {
      return 0;
    }

    // Deserialize embeddings
    const nodeEmbs: Array<{ id: string; importance: number; vec: number[] }> =
      [];
    for (const row of candidates) {
      try {
        const vec = EmbeddingService.blobToVector(row.embedding);
        nodeEmbs.push({ id: row.id, importance: row.importance, vec });
      } catch {
        // Skip rows with invalid embedding data
        continue;
      }
    }

    if (nodeEmbs.length < 2) {
      return 0;
    }

    // Pre-compute norms for quick rejection
    const norms = nodeEmbs.map(n => Math.sqrt(n.vec.reduce((s, v) => s + v * v, 0)));

    const threshold = this.config.mergeSimilarityThreshold;
    const mergedIds = new Set<string>();
    let mergeCount = 0;

    const now = new Date().toISOString();
    const softDeleteStmt = this.db.prepare(
      `UPDATE knowledge_nodes SET deleted_at = ? WHERE id = ?`,
    );
    const insertEdgeStmt = this.db.prepare(
      `INSERT INTO knowledge_edges (id, source_node_id, target_node_id, relation_type, weight)
       VALUES (?, ?, ?, 'merged_from', ?)`,
    );

    const mergeTransaction = this.db.transaction(() => {
      for (let i = 0; i < nodeEmbs.length; i++) {
        const a = nodeEmbs[i];
        if (mergedIds.has(a.id)) {
          continue;
        }

        for (let j = i + 1; j < nodeEmbs.length; j++) {
          const b = nodeEmbs[j];
          if (mergedIds.has(b.id)) {
            continue;
          }

          // Norm-ratio pre-filter: if min/max norm ratio < threshold, cosine can't exceed it
          const minNorm = Math.min(norms[i], norms[j]);
          const maxNorm = Math.max(norms[i], norms[j]);
          if (maxNorm > 0 && minNorm / maxNorm < threshold) continue;

          const similarity = EmbeddingService.cosineSimilarity(a.vec, b.vec);
          if (similarity < threshold) {
            continue;
          }

          // Keep the node with higher importance
          let keepId: string;
          let discardId: string;
          if (a.importance >= b.importance) {
            keepId = a.id;
            discardId = b.id;
          } else {
            keepId = b.id;
            discardId = a.id;
          }

          // Record merge provenance edge
          insertEdgeStmt.run(randomUUID(), keepId, discardId, similarity);

          // Soft-delete the discarded node
          softDeleteStmt.run(now, discardId);
          mergedIds.add(discardId);
          mergeCount++;

          // If node a was discarded, stop comparing it with further nodes
          if (discardId === a.id) {
            break;
          }
        }
      }
    });

    mergeTransaction();
    return mergeCount;
  }

  // -- Prune Stale ----------------------------------------------------------

  /**
   * Soft-delete old, low-importance, non-pinned nodes.
   *
   * A node is pruned when ALL conditions are met:
   * - importance <= pruneImportanceThreshold
   * - pinned = 0
   * - age > 2 * recencyHalfLifeDays
   * - not already soft-deleted
   *
   * @returns Number of nodes pruned.
   */
  private pruneStale(): number {
    const maxAgeDays = this.config.recencyHalfLifeDays * 2;
    const now = new Date();
    const cutoff = new Date(
      now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    const candidates = this.db
      .prepare(
        `SELECT id, importance, pinned, created_at
         FROM knowledge_nodes
         WHERE deleted_at IS NULL
           AND pinned = 0
           AND importance <= ?
           AND created_at < ?`,
      )
      .all(
        this.config.pruneImportanceThreshold,
        cutoff,
      ) as PruneCandidateRow[];

    if (candidates.length === 0) {
      return 0;
    }

    const nowIso = now.toISOString();
    const softDeleteStmt = this.db.prepare(
      `UPDATE knowledge_nodes SET deleted_at = ? WHERE id = ?`,
    );

    const pruneTransaction = this.db.transaction(() => {
      for (const row of candidates) {
        softDeleteStmt.run(nowIso, row.id);
      }
    });

    pruneTransaction();
    return candidates.length;
  }
}
