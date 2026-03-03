/**
 * MemoryFacade: top-level coordinator for the memory system.
 *
 * Wires together all memory pipeline modules into a single API:
 *   - Store knowledge nodes (with deduplication + optional embedding)
 *   - Search via HybridSearch (FTS5 + vector + graph) -> Reranker -> Assembler
 *   - Extract knowledge from conversation messages (regex or LLM)
 *   - Evolve (merge similar, prune stale)
 *   - Reflect (LLM insight synthesis)
 *
 * Electron-free: accepts a dbPath and creates its own sql.js (WASM)
 * connection. All services are injected at construction time via config.
 */

import { randomUUID, createHash } from 'node:crypto';
import { SqliteDatabase } from './db-adapter.js';
import type {
  KnowledgeNode,
  KnowledgeNodeCreate,
  MemoryConfig,
  MemoryTopic,
  NodeType,
  RelationType,
  RetrievalResult,
  AssembledContext,
  EvolutionResult,
  ReflectionResult,
  EmbeddingProvider,
} from './types.js';
import { DEFAULT_MEMORY_CONFIG } from './types.js';
import { MemoryRetriever } from './retriever.js';
import { RegexExtractor } from './extractor.js';
import { ContextAssembler } from './assembler.js';
import { EmbeddingService } from './embedding-service.js';
import { MemoryEvolver } from './evolver.js';
import { ReflectionEngine } from './reflector.js';
import type { ReflectionLlmFn } from './reflector.js';
import { isVecTableAvailable, upsertVecEmbedding } from './hybrid-search.js';
import { HybridSearch } from './hybrid-search.js';
import { Reranker } from './reranker.js';
import { Pipeline } from './pipeline.js';
import type { AnnotatedMessage } from './pipeline.js';
import { ExtractionStage, RegexStrategy } from './extraction-strategy.js';
import type { ExtractionStrategy, ExtractionStageInput } from './extraction-strategy.js';
import { LlmStrategy } from './llm-strategy.js';
import {
  ProviderTagger,
  ReMentionDetector,
  ConflictChecker,
  StorageStage,
} from './storage-stages.js';
import type { StorageResult } from './storage-stages.js';
import type { RetrievalPipelineData } from './types.js';
import { getMemoryEventBus } from './event-bus.js';

// ── Configuration ────────────────────────────────────────────────────

/** Configuration for constructing a MemoryFacade. */
export interface MemoryFacadeConfig {
  /** Path to the SQLite database file, or ':memory:' for in-memory. */
  dbPath: string;
  /** Optional embedding provider for vector search. */
  embeddingProvider?: EmbeddingProvider;
  /** Optional LLM function for reflection and LLM extraction. */
  reflectionLlmFn?: ReflectionLlmFn;
  /** Optional partial memory config overrides. */
  memoryConfig?: Partial<MemoryConfig>;
  /** Optional callback invoked when an embedding generation fails. */
  onEmbeddingFailure?: (nodeId: string, error: Error) => void;
}

// ── SQL Schema ───────────────────────────────────────────────────────

const SCHEMA_SQL = `
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

  CREATE TABLE IF NOT EXISTS knowledge_edges (
    id TEXT PRIMARY KEY,
    source_node_id TEXT REFERENCES knowledge_nodes(id),
    target_node_id TEXT REFERENCES knowledge_nodes(id),
    relation_type TEXT NOT NULL,
    weight REAL DEFAULT 1.0,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
`;

// ── Facade ──────────────────────────────────────────────────────────

/**
 * Unified interface for the memory system.
 *
 * Coordinates retrieval, extraction, context assembly,
 * evolution, and reflection. Acts as the single entry point
 * for all memory operations.
 *
 * Owns its SQLite connection and all sub-services.
 */
export class MemoryFacade {
  private db: SqliteDatabase | null = null;
  private readonly dbPath: string;
  private readonly config: MemoryConfig;
  private readonly embeddingProvider: EmbeddingProvider | null;
  private readonly reflectionLlmFn: ReflectionLlmFn | null;
  private _pendingEmbeddings = 0;
  private _failedEmbeddings = 0;
  private readonly onEmbeddingFailure: ((nodeId: string, error: Error) => void) | null;

  // Sub-services (initialized in initialize())
  private retriever: MemoryRetriever | null = null;
  private extractor: RegexExtractor | null = null;
  private assembler: ContextAssembler | null = null;
  private embeddingService: EmbeddingService | null = null;
  private evolver: MemoryEvolver | null = null;
  private reflector: ReflectionEngine | null = null;
  private extractionStrategy: ExtractionStrategy | null = null;
  private initialized = false;

  constructor(facadeConfig: MemoryFacadeConfig) {
    this.dbPath = facadeConfig.dbPath;
    this.config = { ...DEFAULT_MEMORY_CONFIG, ...facadeConfig.memoryConfig };
    this.embeddingProvider = facadeConfig.embeddingProvider ?? null;
    this.reflectionLlmFn = facadeConfig.reflectionLlmFn ?? null;
    this.onEmbeddingFailure = facadeConfig.onEmbeddingFailure ?? null;
  }

  /** Whether the facade has been initialized. */
  get isInitialized(): boolean {
    return this.initialized;
  }

  get embeddingStats(): { pending: number; failed: number } {
    return { pending: this._pendingEmbeddings, failed: this._failedEmbeddings };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  /**
   * Initialize the memory system.
   *
   * Creates the SQLite database (via sql.js WASM), sets up tables/triggers/FTS5,
   * and wires all sub-services.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Create database connection
    this.db = await SqliteDatabase.create(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    // Create schema
    this.db.exec(SCHEMA_SQL);

    // Wire services
    this.embeddingService = this.embeddingProvider
      ? new EmbeddingService(this.embeddingProvider)
      : null;

    this.retriever = new MemoryRetriever(
      this.db,
      this.config,
      this.embeddingService ?? undefined,
    );

    this.extractor = new RegexExtractor(this.config);
    this.assembler = new ContextAssembler(this.config);

    // Evolver (merge needs embeddings; prune is embedding-independent)
    const evolverEmbedding = this.embeddingService ?? new EmbeddingService();
    this.evolver = new MemoryEvolver(this.db, evolverEmbedding, this.config);

    // Reflector (requires LLM function)
    if (this.reflectionLlmFn) {
      this.reflector = new ReflectionEngine(this.db, this.reflectionLlmFn, this.config);
    }

    // Extraction strategy (LLM or regex)
    if (this.config.extractionLlmProviderId && this.reflectionLlmFn) {
      this.extractionStrategy = new LlmStrategy(this.reflectionLlmFn);
    } else {
      this.extractionStrategy = new RegexStrategy(this.config);
    }

    this.initialized = true;
  }

  /**
   * Close the SQLite connection and clean up.
   *
   * Safe to call multiple times.
   */
  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // Ignore errors on close (e.g., already closed)
      }
      this.db = null;
    }
    this.initialized = false;
    this._pendingEmbeddings = 0;
    this._failedEmbeddings = 0;
    this.retriever = null;
    this.extractor = null;
    this.assembler = null;
    this.embeddingService = null;
    this.evolver = null;
    this.reflector = null;
    this.extractionStrategy = null;
  }

  // ── Store Operations ──────────────────────────────────────────────

  /**
   * Store a new knowledge node.
   *
   * Handles deduplication, FTS5 sync (via trigger), and optional
   * async embedding generation.
   *
   * @returns The created (or existing duplicate) node's ID.
   */
  store(data: KnowledgeNodeCreate): string {
    this.ensureInitialized();

    const id = randomUUID();
    const now = new Date().toISOString();
    const sourceHash = data.sourceHash ?? this.computeHash(data.content);
    const dedupeKey = data.dedupeKey ?? this.computeDedupeKey(data.content);

    // Check for duplicates
    if (this.isDuplicate(dedupeKey)) {
      const existing = this.findByDedupeKey(dedupeKey);
      if (existing) return existing.id;
    }

    this.db!
      .prepare(
        `INSERT INTO knowledge_nodes
         (id, content, node_type, topic, importance, source, pinned,
          conversation_id, message_id, last_accessed, created_at, updated_at,
          source_hash, dedupe_key, provider_id, confidence)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        data.content,
        data.nodeType,
        data.topic,
        data.importance,
        data.source,
        data.conversationId ?? null,
        data.messageId ?? null,
        now,
        now,
        now,
        sourceHash,
        dedupeKey,
        data.providerId ?? null,
        data.confidence ?? 0.5,
      );

    // Queue async embedding generation (fire-and-forget)
    if (this.embeddingService?.available) {
      this._pendingEmbeddings++;
      void this.embedAndUpdate(id, data.content);
    }

    return id;
  }

  // ── Search Operations ─────────────────────────────────────────────

  /**
   * Search memory using hybrid retrieval (FTS5 + vector + graph).
   *
   * Returns scored results sorted by relevance.
   */
  async search(
    query: string,
    options?: { topic?: MemoryTopic; nodeType?: NodeType; limit?: number },
  ): Promise<RetrievalResult[]> {
    this.ensureInitialized();
    return this.retriever!.search(query, options);
  }

  /**
   * Get a knowledge node by ID.
   */
  getNode(id: string): KnowledgeNode | null {
    this.ensureInitialized();
    return this.retriever!.getNode(id);
  }

  /**
   * Get all pinned knowledge nodes.
   */
  getPinnedNodes(topic?: MemoryTopic): KnowledgeNode[] {
    this.ensureInitialized();
    return this.retriever!.getPinnedNodes(topic);
  }

  // ── Context Assembly ──────────────────────────────────────────────

  /**
   * Retrieve relevant memories and assemble them into prompt context.
   *
   * Runs the retrieval pipeline:
   *   HybridSearch -> Reranker -> ContextAssembler
   */
  async getAssembledContext(params: {
    query: string;
    systemPrompt?: string;
    recentHistory?: string;
    userMessage?: string;
    topic?: MemoryTopic;
  }): Promise<AssembledContext> {
    this.ensureInitialized();

    const retrievalPipeline = Pipeline.create<RetrievalPipelineData>('retrieval')
      .addStage(new HybridSearch(this.db!, this.config, this.embeddingService ?? undefined))
      .addStage(new Reranker(this.config));

    const pipelineResult = await retrievalPipeline.execute({
      query: params.query,
      topic: params.topic,
      results: [],
    });

    const memories = pipelineResult.output?.results ?? [];

    return this.assembler!.assemble({
      memories,
      systemPrompt: params.systemPrompt,
      recentHistory: params.recentHistory,
      userMessage: params.userMessage,
    });
  }

  // ── Extraction (Pipeline) ─────────────────────────────────────────

  /**
   * Extract and store memories from conversation messages.
   *
   * Runs the full storage pipeline:
   *   ExtractionStage -> ProviderTagger -> ReMentionDetector
   *   -> ConflictChecker -> StorageStage
   *
   * @returns Storage result with counts.
   */
  async extractAndStore(
    messages: AnnotatedMessage[],
    conversationId?: string,
  ): Promise<StorageResult> {
    this.ensureInitialized();

    const pipeline = Pipeline.create<ExtractionStageInput>('storage')
      .addStage(new ExtractionStage(this.extractionStrategy!, this.config))
      .addStage(new ProviderTagger())
      .addStage(new ReMentionDetector(this.db!, this.config))
      .addStage(new ConflictChecker(this.db!))
      .addStage(new StorageStage(this.db!, this.config));

    const result = await pipeline.execute({ messages, conversationId });

    if (result.output) {
      // Queue embedding for newly stored items
      if (this.embeddingService?.available) {
        void this.embedNewNodes();
      }
      return result.output;
    }

    return { stored: 0, skipped: 0, mentions: 0, conflicts: 0 };
  }

  // ── Evolution ─────────────────────────────────────────────────────

  /**
   * Run memory evolution: merge similar nodes and prune stale ones.
   */
  evolve(): EvolutionResult {
    this.ensureInitialized();

    if (!this.evolver) {
      return { merged: 0, pruned: 0 };
    }
    return this.evolver.evolve();
  }

  // ── Reflection ────────────────────────────────────────────────────

  /**
   * Check if enough nodes have accumulated for reflection.
   */
  shouldReflect(): boolean {
    this.ensureInitialized();

    if (!this.reflector) return false;
    return this.reflector.shouldReflect();
  }

  /**
   * Run the reflection engine to generate insights.
   */
  async reflect(): Promise<ReflectionResult> {
    this.ensureInitialized();

    if (!this.reflector) {
      return { insightsCreated: 0, nodesProcessed: 0 };
    }
    return this.reflector.reflect();
  }

  // ── Pin Operations ────────────────────────────────────────────────

  /**
   * Pin a message to memory.
   *
   * If the message content is already in memory, boosts importance.
   * Otherwise creates a new pinned node.
   *
   * @returns The knowledge node ID.
   */
  pinMessage(
    messageId: string,
    content: string,
    topic: MemoryTopic,
  ): string {
    this.ensureInitialized();

    const existing = this.db!
      .prepare(
        `SELECT id, importance FROM knowledge_nodes
         WHERE message_id = ? AND deleted_at IS NULL`,
      )
      .get(messageId) as { id: string; importance: number } | undefined;

    if (existing) {
      const boosted = Math.min(1.0, existing.importance + this.config.pinImportanceBoost);
      this.db!
        .prepare(
          `UPDATE knowledge_nodes
           SET pinned = 1, importance = ?, topic = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(boosted, topic, new Date().toISOString(), existing.id);
      return existing.id;
    }

    const id = this.store({
      content,
      nodeType: 'fact',
      topic,
      importance: this.config.pinDefaultImportance,
      source: 'pin',
      messageId,
    });

    this.db!
      .prepare(`UPDATE knowledge_nodes SET pinned = 1, updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);

    return id;
  }

  // ── Soft Delete ───────────────────────────────────────────────────

  /**
   * Soft-delete a knowledge node.
   */
  deleteNode(id: string): boolean {
    this.ensureInitialized();

    const result = this.db!
      .prepare(
        `UPDATE knowledge_nodes SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(new Date().toISOString(), id);

    return result.changes > 0;
  }

  // ── Edge Operations ──────────────────────────────────────────────

  /**
   * Add an edge between two knowledge nodes.
   *
   * @returns The edge ID.
   */
  addEdge(
    sourceId: string,
    targetId: string,
    relationType: RelationType,
    weight?: number,
  ): string {
    this.ensureInitialized();

    const id = randomUUID();
    this.db!
      .prepare(
        `INSERT INTO knowledge_edges (id, source_node_id, target_node_id, relation_type, weight, created_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      )
      .run(id, sourceId, targetId, relationType, weight ?? 1.0);

    return id;
  }

  // ── Embedding Operations ──────────────────────────────────────────

  /**
   * Embed all nodes that don't yet have an embedding.
   */
  async embedUnembeddedNodes(limit = 50): Promise<number> {
    this.ensureInitialized();

    if (!this.embeddingService?.available) return 0;

    const rows = this.db!
      .prepare(
        `SELECT id, content FROM knowledge_nodes
         WHERE embedding IS NULL AND deleted_at IS NULL
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{ id: string; content: string }>;

    let count = 0;
    for (const row of rows) {
      await this.embedAndUpdate(row.id, row.content);
      count++;
    }

    return count;
  }

  // ── Database Access (for advanced use) ────────────────────────────

  /**
   * Get the underlying database instance.
   *
   * Exposed for sub-modules and tests that need direct DB access.
   * Returns null if not initialized.
   */
  getDatabase(): SqliteDatabase | null {
    return this.db;
  }

  // ── Private Helpers ───────────────────────────────────────────────

  private ensureInitialized(): void {
    if (!this.initialized || !this.db) {
      throw new Error('MemoryFacade is not initialized. Call initialize() first.');
    }
  }

  private computeHash(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  private computeDedupeKey(content: string): string {
    const normalized = content.trim().toLowerCase().replace(/\s+/g, ' ');
    return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  }

  private isDuplicate(dedupeKey: string): boolean {
    const row = this.db!
      .prepare(
        `SELECT 1 FROM knowledge_nodes WHERE dedupe_key = ? AND deleted_at IS NULL LIMIT 1`,
      )
      .get(dedupeKey);

    return row !== undefined;
  }

  private findByDedupeKey(dedupeKey: string): { id: string } | null {
    const row = this.db!
      .prepare(
        `SELECT id FROM knowledge_nodes WHERE dedupe_key = ? AND deleted_at IS NULL LIMIT 1`,
      )
      .get(dedupeKey) as { id: string } | undefined;

    return row ?? null;
  }

  /**
   * Generate and store an embedding for a single node.
   */
  private async embedAndUpdate(nodeId: string, content: string): Promise<void> {
    if (!this.embeddingService || !this.db) return;

    try {
      const vec = await this.embeddingService.embedText(content);
      if (!vec) return;

      const blob = EmbeddingService.vectorToBlob(vec);
      this.db
        .prepare(
          `UPDATE knowledge_nodes
           SET embedding = ?, embedding_version = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(blob, this.embeddingService.modelId, new Date().toISOString(), nodeId);

      // Dual-write float32 to knowledge_vec for ANN search (when sqlite-vec is available)
      if (isVecTableAvailable(this.db)) {
        const float32Blob = EmbeddingService.vectorToFloat32Blob(vec);
        upsertVecEmbedding(this.db, nodeId, float32Blob);
      }
      this._pendingEmbeddings = Math.max(0, this._pendingEmbeddings - 1);
    } catch (err: unknown) {
      this._failedEmbeddings++;
      this._pendingEmbeddings = Math.max(0, this._pendingEmbeddings - 1);
      const error = err instanceof Error ? err : new Error(String(err));
      if (this.onEmbeddingFailure) {
        this.onEmbeddingFailure(nodeId, error);
      }
      getMemoryEventBus().emitError('embedding_failed', 'Embedding generation failed', {
        nodeId,
        error,
      });
    }
  }

  /**
   * Embed recently stored nodes (called after pipeline storage).
   */
  private async embedNewNodes(): Promise<void> {
    await this.embedUnembeddedNodes(20);
  }
}
