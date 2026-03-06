/**
 * HybridSearch pipeline stage + sqlite-vec utilities.
 *
 * Performs hybrid memory search combining multiple retrieval sources:
 *   1. FTS5 full-text search (BM25 rank)
 *   2. Knowledge graph BFS expansion
 *   3. Vector search via sqlite-vec (optional, returns empty when unavailable)
 *
 * Results from all sources are fused using configurable weighted combination.
 * Each individual result is scored with the Stanford 3-factor model
 * (recency x relevance x importance).
 *
 * When sqlite-vec is available:
 *   - Vector search uses ANN via knowledge_vec (O(log n))
 *   - Falls back to JS full-scan with event bus notification
 *
 * Without sqlite-vec:
 *   - Vector search returns empty results
 *   - FTS5 + graph BFS still work normally
 */

import type { SqliteDatabase } from './db-adapter.js';
import type {
  KnowledgeNode,
  MemoryConfig,
  MemoryTopic,
  NodeType,
  RetrievalResult,
  RetrievalPipelineData,
} from './types.js';
import { DEFAULT_MEMORY_CONFIG } from './types.js';
import type { PipelineStage } from './pipeline.js';
import { getMemoryEventBus } from './event-bus.js';
import { computeRecency, computeCombinedScore } from './scorer.js';
import { EmbeddingService } from './embedding-service.js';

// ── sqlite-vec Utilities ────────────────────────────────────────────

/**
 * Check if the knowledge_vec virtual table exists.
 *
 * This indicates that sqlite-vec was loaded and the table was
 * successfully created. Cached per-call -- the caller should
 * cache the result if checking frequently.
 */
export function isVecTableAvailable(db: SqliteDatabase): boolean {
  try {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_vec'",
    ).get();
    return row !== undefined;
  } catch {
    return false;
  }
}

/**
 * Try to create the knowledge_vec virtual table using sqlite-vec.
 *
 * Returns true if the table was created (or already exists).
 * Returns false if sqlite-vec is not loaded (vec0 module unavailable).
 *
 * @param dimension - Embedding vector dimension (default 1536 for OpenAI).
 */
export function tryInitVecTable(db: SqliteDatabase, dimension = 1536): boolean {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_vec USING vec0(
        node_id TEXT PRIMARY KEY,
        embedding float[${dimension}]
      )
    `);
    return true;
  } catch {
    return false;
  }
}

/**
 * Upsert a node's embedding into the knowledge_vec table.
 *
 * The float32Blob should be created with EmbeddingService.vectorToFloat32Blob().
 * Uses DELETE + INSERT since vec0 doesn't support INSERT OR REPLACE.
 */
export function upsertVecEmbedding(
  db: SqliteDatabase,
  nodeId: string,
  float32Blob: Buffer,
): void {
  db.prepare('DELETE FROM knowledge_vec WHERE node_id = ?').run(nodeId);
  db.prepare(
    'INSERT INTO knowledge_vec (node_id, embedding) VALUES (?, ?)',
  ).run(nodeId, float32Blob);
}

/**
 * Remove a node's embedding from the knowledge_vec table.
 */
export function deleteVecEmbedding(db: SqliteDatabase, nodeId: string): void {
  db.prepare('DELETE FROM knowledge_vec WHERE node_id = ?').run(nodeId);
}

/**
 * Sync all embeddings from knowledge_nodes to knowledge_vec.
 *
 * Used after initial sqlite-vec setup to populate the ANN index
 * from existing float64 BLOB embeddings.
 *
 * @returns Number of embeddings synced.
 */
export function syncAllEmbeddingsToVec(
  db: SqliteDatabase,
  vectorToFloat32: (blob: Buffer | Uint8Array) => Buffer,
): number {
  const rows = db.prepare(
    `SELECT id, embedding FROM knowledge_nodes
     WHERE embedding IS NOT NULL AND deleted_at IS NULL`,
  ).all() as Array<{ id: string; embedding: Buffer | Uint8Array }>;

  if (rows.length === 0) return 0;

  const deleteStmt = db.prepare('DELETE FROM knowledge_vec WHERE node_id = ?');
  const insertStmt = db.prepare(
    'INSERT INTO knowledge_vec (node_id, embedding) VALUES (?, ?)',
  );

  const syncAll = db.transaction(() => {
    for (const row of rows) {
      const float32 = vectorToFloat32(row.embedding);
      deleteStmt.run(row.id);
      insertStmt.run(row.id, float32);
    }
  });

  syncAll();
  return rows.length;
}

// ── Internal Types ──────────────────────────────────────────────────

/** Raw row from knowledge_nodes query. */
interface NodeRow {
  id: string;
  content: string;
  node_type: string;
  topic: string;
  importance: number;
  source: string;
  pinned: number;
  conversation_id: string | null;
  message_id: string | null;
  last_accessed: string | null;
  created_at: string;
  updated_at: string;
  embedding_version: string | null;
  extractor_version: string | null;
  source_hash: string | null;
  dedupe_key: string | null;
  deleted_at: string | null;
  provider_id: string | null;
  last_mentioned_at: string | null;
  mention_count: number;
  confidence: number;
  rank?: number;
  embedding?: Buffer | Uint8Array | null;
}

/** Convert a database row to a KnowledgeNode. */
function rowToNode(row: NodeRow): KnowledgeNode {
  return {
    id: row.id,
    content: row.content,
    nodeType: row.node_type as KnowledgeNode['nodeType'],
    topic: row.topic as KnowledgeNode['topic'],
    importance: row.importance,
    source: row.source as KnowledgeNode['source'],
    pinned: row.pinned === 1,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    lastAccessed: row.last_accessed,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    embeddingVersion: row.embedding_version,
    extractorVersion: row.extractor_version,
    sourceHash: row.source_hash,
    dedupeKey: row.dedupe_key,
    deletedAt: row.deleted_at,
    providerId: row.provider_id,
    lastMentionedAt: row.last_mentioned_at,
    mentionCount: row.mention_count ?? 0,
    confidence: row.confidence ?? 0.5,
  };
}

/** Internal scored entry keyed by node ID for fusion. */
interface ScoredEntry {
  node: KnowledgeNode;
  score: number;
  source: RetrievalResult['source'];
}

// ── HybridSearch Pipeline Stage ─────────────────────────────────────

/**
 * Pipeline stage that performs hybrid search (FTS5 + Vector + Graph).
 *
 * Accepts a SqliteDatabase instance and an optional EmbeddingService.
 * Performs direct database queries for FTS5, graph BFS, and optionally
 * vector search (when sqlite-vec is available).
 */
export class HybridSearch implements PipelineStage<RetrievalPipelineData, RetrievalPipelineData> {
  readonly name = 'HybridSearch';
  private readonly db: SqliteDatabase;
  private readonly config: MemoryConfig;
  private embeddingService: EmbeddingService | null;
  private _vecAvailable: boolean | null = null;

  constructor(
    db: SqliteDatabase,
    config?: Partial<MemoryConfig>,
    embeddingService?: EmbeddingService,
  ) {
    this.db = db;
    this.config = { ...DEFAULT_MEMORY_CONFIG, ...config };
    this.embeddingService = embeddingService ?? null;
  }

  /** Whether the sqlite-vec knowledge_vec table is available for ANN search. */
  get vecAvailable(): boolean {
    if (this._vecAvailable === null) {
      this._vecAvailable = isVecTableAvailable(this.db);
    }
    return this._vecAvailable;
  }

  /** Reset the cached vec availability flag (e.g., after loading sqlite-vec). */
  resetVecCache(): void {
    this._vecAvailable = null;
  }

  /** Set or replace the embedding service (allows lazy initialization). */
  setEmbeddingService(service: EmbeddingService): void {
    this.embeddingService = service;
  }

  async execute(input: RetrievalPipelineData): Promise<RetrievalPipelineData | null> {
    if (!input.query || input.query.trim().length === 0) {
      return null;
    }

    try {
      const results = await this.search(input.query, {
        topic: input.topic,
        nodeType: input.nodeType,
        limit: input.limit,
      });

      return { ...input, results };
    } catch (err: unknown) {
      getMemoryEventBus().emitError(
        'fts_query_failed',
        'HybridSearch stage failed',
        { error: err instanceof Error ? err : new Error(String(err)) },
      );
      return { ...input, results: [] };
    }
  }

  /**
   * Search for relevant memories using hybrid retrieval.
   *
   * When vector search is enabled and an embedding service is available,
   * combines FTS5, vector, and graph results with weighted fusion.
   * Otherwise falls back to FTS5-only search.
   */
  async search(
    query: string,
    options?: { topic?: MemoryTopic; nodeType?: NodeType; limit?: number },
  ): Promise<RetrievalResult[]> {
    if (!query || query.trim().length === 0) {
      return [];
    }

    const limit = options?.limit ?? this.config.retrievalLimit;
    const topic = options?.topic;
    const nodeType = options?.nodeType;
    const useVector = this.config.vectorEnabled && this.embeddingService?.available === true;
    const useGraph = this.config.graphEnabled;

    // FTS5 search (always runs when enabled)
    const ftsScores = this.config.ftsEnabled
      ? this.ftsSearchScored(query, topic, limit * 3, nodeType)
      : new Map<string, ScoredEntry>();

    // Vector search (when available)
    let vectorScores = new Map<string, ScoredEntry>();
    if (useVector && this.embeddingService) {
      vectorScores = await this.vectorSearch(query, topic, limit * 3, nodeType);
    }

    // Graph expansion from top seeds (skip if L2 results are sufficient)
    let graphScores = new Map<string, ScoredEntry>();
    if (useGraph && (ftsScores.size > 0 || vectorScores.size > 0)) {
      const topL2Score = this.getTopScore(ftsScores, vectorScores);
      if (topL2Score < this.config.graphSkipThreshold) {
        const seedIds = this.getSeedIds(ftsScores, vectorScores, 5);
        graphScores = this.graphExpand(seedIds);
      }
    }

    // Fuse or use single source
    let results: RetrievalResult[];
    if (useVector || useGraph) {
      results = this.fuseResults(ftsScores, vectorScores, graphScores);
    } else {
      results = Array.from(ftsScores.values());
    }

    if (results.length === 0) {
      return [];
    }

    // Apply pin boost
    const pinBoost = this.config.pinSearchBoost;
    results = results.map((r) => ({
      ...r,
      score: r.node.pinned ? Math.min(1.0, r.score * pinBoost) : r.score,
    }));

    // Sort by score descending and limit
    results.sort((a, b) => b.score - a.score);
    results = results.slice(0, limit);

    // Touch accessed nodes to update recency
    this.touchNodes(results.map((r) => r.node.id));

    return results;
  }

  /**
   * Get a single knowledge node by ID.
   */
  getNode(id: string): KnowledgeNode | null {
    const row = this.db
      .prepare(
        `SELECT * FROM knowledge_nodes WHERE id = ? AND deleted_at IS NULL`,
      )
      .get(id) as NodeRow | undefined;

    return row ? rowToNode(row) : null;
  }

  /**
   * Get all pinned knowledge nodes.
   */
  getPinnedNodes(topic?: MemoryTopic): KnowledgeNode[] {
    let sql = `SELECT * FROM knowledge_nodes WHERE pinned = 1 AND deleted_at IS NULL`;
    const params: unknown[] = [];

    if (topic) {
      sql += ` AND topic = ?`;
      params.push(topic);
    }

    sql += ` ORDER BY importance DESC, created_at DESC`;

    const rows = this.db.prepare(sql).all(...params) as NodeRow[];
    return rows.map(rowToNode);
  }

  // ── FTS5 Search ────────────────────────────────────────────────────

  /**
   * Execute FTS5 search and return scored entries keyed by node ID.
   */
  private ftsSearchScored(
    query: string,
    topic: MemoryTopic | undefined,
    fetchLimit: number,
    nodeType?: NodeType,
  ): Map<string, ScoredEntry> {
    const safeQuery = this.escapeFtsQuery(query);
    if (!safeQuery) {
      return new Map();
    }

    let sql = `
      SELECT kn.*, kf.rank
      FROM knowledge_fts kf
      JOIN knowledge_nodes kn ON kn.rowid = kf.rowid
      WHERE knowledge_fts MATCH ?
        AND kn.deleted_at IS NULL
    `;
    const params: unknown[] = [safeQuery];

    if (topic) {
      sql += ` AND kn.topic = ?`;
      params.push(topic);
    }

    if (nodeType) {
      sql += ` AND kn.node_type = ?`;
      params.push(nodeType);
    }

    sql += ` ORDER BY kf.rank LIMIT ?`;
    params.push(fetchLimit);

    let rows: NodeRow[];
    try {
      rows = this.db.prepare(sql).all(...params) as NodeRow[];
    } catch (err: unknown) {
      getMemoryEventBus().emitError('fts_query_failed', `FTS5 query failed for: ${query}`, {
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return new Map();
    }

    if (rows.length === 0) {
      return new Map();
    }

    // Normalize FTS5 ranks to [0, 1]
    const ranks = rows.map((r) => r.rank ?? 0);
    const minRank = Math.min(...ranks);
    const maxRank = Math.max(...ranks);
    const rankRange = maxRank - minRank;

    const scored = new Map<string, ScoredEntry>();
    for (const row of rows) {
      const node = rowToNode(row);
      const rawRelevance =
        rankRange !== 0 ? (maxRank - (row.rank ?? 0)) / rankRange : 1.0;
      const relevance = Math.max(this.config.ftsRelevanceFloor, rawRelevance);

      const recency = computeRecency(
        node.lastAccessed ?? node.createdAt,
        this.config.recencyHalfLifeDays,
      );

      const score = computeCombinedScore(
        recency,
        relevance,
        node.importance,
        this.config.scoringWeights,
      );

      scored.set(node.id, { node, score, source: 'fts' });
    }

    return scored;
  }

  // ── Vector Search ──────────────────────────────────────────────────

  /**
   * Embed query and rank against stored embeddings.
   *
   * When sqlite-vec is available (knowledge_vec table exists), uses
   * ANN search for O(log n) performance. Otherwise falls back to
   * JS-side cosine similarity full scan.
   */
  private async vectorSearch(
    query: string,
    topic: MemoryTopic | undefined,
    fetchLimit: number,
    nodeType?: NodeType,
  ): Promise<Map<string, ScoredEntry>> {
    if (!this.embeddingService) {
      return new Map();
    }

    const queryVec = await this.embeddingService.embedText(query);
    if (!queryVec) {
      return new Map();
    }

    // Try ANN search via sqlite-vec
    if (this.vecAvailable) {
      try {
        return this.vectorSearchANN(queryVec, topic, fetchLimit, nodeType);
      } catch (err: unknown) {
        getMemoryEventBus().emitError(
          'vector_search_fallback',
          'sqlite-vec ANN search failed, falling back to JS full-scan',
          { error: err instanceof Error ? err : new Error(String(err)) },
        );
        // Fall through to JS scan
      }
    }

    // JS full-scan fallback
    return this.vectorSearchFullScan(queryVec, topic, fetchLimit, nodeType);
  }

  /**
   * ANN vector search via sqlite-vec knowledge_vec table.
   */
  private vectorSearchANN(
    queryVec: number[],
    topic: MemoryTopic | undefined,
    fetchLimit: number,
    nodeType?: NodeType,
  ): Map<string, ScoredEntry> {
    const scored = new Map<string, ScoredEntry>();

    const float32Blob = EmbeddingService.vectorToFloat32Blob(queryVec);

    let sql = `
      SELECT kv.node_id, kv.distance, kn.*
      FROM knowledge_vec kv
      JOIN knowledge_nodes kn ON kn.id = kv.node_id
      WHERE kv.embedding MATCH ?
        AND kn.deleted_at IS NULL
    `;
    const params: unknown[] = [float32Blob];

    if (topic) {
      sql += ` AND kn.topic = ?`;
      params.push(topic);
    }

    if (nodeType) {
      sql += ` AND kn.node_type = ?`;
      params.push(nodeType);
    }

    sql += ` ORDER BY kv.distance LIMIT ?`;
    params.push(fetchLimit);

    const rows = this.db.prepare(sql).all(...params) as Array<NodeRow & { distance: number }>;

    if (rows.length === 0) return scored;

    // Convert L2 distance to similarity score [0, 1]
    const maxDist = Math.max(...rows.map((r) => r.distance));

    for (const row of rows) {
      const node = rowToNode(row);
      const similarity = maxDist > 0 ? 1 - row.distance / (maxDist + 1) : 1.0;

      const recency = computeRecency(
        node.lastAccessed ?? node.createdAt,
        this.config.recencyHalfLifeDays,
      );

      const score = computeCombinedScore(
        recency,
        similarity,
        node.importance,
        this.config.scoringWeights,
      );

      scored.set(node.id, { node, score, source: 'vector' });
    }

    return scored;
  }

  /**
   * JS-side cosine similarity full scan (fallback when sqlite-vec unavailable).
   */
  private vectorSearchFullScan(
    queryVec: number[],
    topic: MemoryTopic | undefined,
    fetchLimit: number,
    nodeType?: NodeType,
  ): Map<string, ScoredEntry> {
    const scored = new Map<string, ScoredEntry>();

    let sql = `SELECT * FROM knowledge_nodes WHERE embedding IS NOT NULL AND deleted_at IS NULL`;
    const params: unknown[] = [];

    if (topic) {
      sql += ` AND topic = ?`;
      params.push(topic);
    }

    if (nodeType) {
      sql += ` AND node_type = ?`;
      params.push(nodeType);
    }

    sql += ` LIMIT ?`;
    params.push(fetchLimit);

    const candidates = this.db.prepare(sql).all(...params) as NodeRow[];
    if (candidates.length === 0) {
      return scored;
    }

    const embeddingCandidates: Array<{ id: string; embedding: Buffer | Uint8Array }> = [];
    for (const row of candidates) {
      if (row.embedding) {
        embeddingCandidates.push({ id: row.id, embedding: row.embedding as Buffer | Uint8Array });
      }
    }

    const ranked = new EmbeddingService().rankBySimilarity(queryVec, embeddingCandidates);

    const nodeMap = new Map<string, KnowledgeNode>();
    for (const row of candidates) {
      nodeMap.set(row.id, rowToNode(row));
    }

    for (const { id, similarity } of ranked) {
      const node = nodeMap.get(id);
      if (!node || similarity <= 0) continue;

      const recency = computeRecency(
        node.lastAccessed ?? node.createdAt,
        this.config.recencyHalfLifeDays,
      );

      const score = computeCombinedScore(
        recency,
        similarity,
        node.importance,
        this.config.scoringWeights,
      );

      scored.set(id, { node, score, source: 'vector' });
    }

    return scored;
  }

  // ── Graph Expansion ────────────────────────────────────────────────

  /**
   * BFS expansion from seed nodes using knowledge edges.
   */
  private graphExpand(seedIds: string[]): Map<string, ScoredEntry> {
    const scored = new Map<string, ScoredEntry>();
    if (seedIds.length === 0) return scored;

    const maxHops = this.config.graphMaxHops;
    const visited = new Set(seedIds);
    let frontier = seedIds;

    for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
      const placeholders = frontier.map(() => '?').join(',');
      const edges = this.db
        .prepare(
          `SELECT target_node_id as target_id, weight FROM knowledge_edges
           WHERE source_node_id IN (${placeholders})
           UNION
           SELECT source_node_id as target_id, weight FROM knowledge_edges
           WHERE target_node_id IN (${placeholders})`,
        )
        .all(...frontier, ...frontier) as Array<{
        target_id: string;
        weight: number;
      }>;

      const nextFrontier: string[] = [];
      for (const edge of edges) {
        if (visited.has(edge.target_id)) continue;
        visited.add(edge.target_id);
        nextFrontier.push(edge.target_id);

        const row = this.db
          .prepare(
            `SELECT * FROM knowledge_nodes WHERE id = ? AND deleted_at IS NULL`,
          )
          .get(edge.target_id) as NodeRow | undefined;

        if (!row) continue;

        const node = rowToNode(row);
        const recency = computeRecency(
          node.lastAccessed ?? node.createdAt,
          this.config.recencyHalfLifeDays,
        );

        // Use edge weight as relevance proxy, decay by hop distance
        const relevance = edge.weight * Math.pow(this.config.graphHopDecay, hop);

        const score = computeCombinedScore(
          recency,
          relevance,
          node.importance,
          this.config.scoringWeights,
        );

        scored.set(node.id, { node, score, source: 'graph' });
      }

      frontier = nextFrontier;
    }

    return scored;
  }

  // ── Fusion ─────────────────────────────────────────────────────────

  /**
   * Return the highest score among L2 (FTS + vector) results.
   */
  private getTopScore(
    ftsScores: Map<string, ScoredEntry>,
    vectorScores: Map<string, ScoredEntry>,
  ): number {
    let top = 0;
    for (const entry of ftsScores.values()) {
      if (entry.score > top) top = entry.score;
    }
    for (const entry of vectorScores.values()) {
      if (entry.score > top) top = entry.score;
    }
    return top;
  }

  /**
   * Pick top node IDs from FTS + vector results as graph seeds.
   */
  private getSeedIds(
    ftsScores: Map<string, ScoredEntry>,
    vectorScores: Map<string, ScoredEntry>,
    topK: number,
  ): string[] {
    const merged = new Map<string, number>();

    for (const [id, entry] of ftsScores) {
      merged.set(id, (merged.get(id) ?? 0) + entry.score);
    }
    for (const [id, entry] of vectorScores) {
      merged.set(id, (merged.get(id) ?? 0) + entry.score);
    }

    return Array.from(merged.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(([id]) => id);
  }

  /**
   * Weighted fusion of scores from multiple retrieval sources.
   *
   * If a node appears in multiple sources, combine with source weights.
   */
  private fuseResults(
    ftsScores: Map<string, ScoredEntry>,
    vectorScores: Map<string, ScoredEntry>,
    graphScores: Map<string, ScoredEntry>,
  ): RetrievalResult[] {
    const allIds = new Set([
      ...ftsScores.keys(),
      ...vectorScores.keys(),
      ...graphScores.keys(),
    ]);

    const { vector: wVector, fts: wFts, graph: wGraph } = this.config.fusionWeights;
    const results: RetrievalResult[] = [];

    for (const id of allIds) {
      const v = vectorScores.get(id);
      const f = ftsScores.get(id);
      const g = graphScores.get(id);

      let weightedSum = 0;
      let totalWeight = 0;

      if (v) {
        weightedSum += wVector * v.score;
        totalWeight += wVector;
      }
      if (f) {
        weightedSum += wFts * f.score;
        totalWeight += wFts;
      }
      if (g) {
        weightedSum += wGraph * g.score;
        totalWeight += wGraph;
      }

      if (totalWeight === 0) continue;

      const fusedScore = weightedSum / totalWeight;

      // Determine primary source and pick node from best source
      let primarySource: RetrievalResult['source'] = 'fts';
      let node: KnowledgeNode;
      if (v && (!f || v.score >= f.score) && (!g || v.score >= g.score)) {
        primarySource = 'vector';
        node = v.node;
      } else if (g && (!f || g.score >= f.score)) {
        primarySource = 'graph';
        node = g.node;
      } else if (f) {
        node = f.node;
      } else {
        continue;
      }

      results.push({ node, score: fusedScore, source: primarySource });
    }

    return results;
  }

  // ── Common Helpers ─────────────────────────────────────────────────

  /**
   * Update last_accessed timestamp for retrieved nodes.
   */
  private touchNodes(nodeIds: string[]): void {
    if (nodeIds.length === 0) return;

    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `UPDATE knowledge_nodes SET last_accessed = ? WHERE id = ?`,
    );

    const updateMany = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        stmt.run(now, id);
      }
    });

    updateMany(nodeIds);
  }

  /**
   * Escape a user query for safe FTS5 MATCH usage.
   */
  private escapeFtsQuery(query: string): string {
    const words = query
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .map((w) => `"${w.replace(/"/g, '""')}"`);

    return words.join(' ');
  }
}
