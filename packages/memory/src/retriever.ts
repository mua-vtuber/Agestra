/**
 * MemoryRetriever: high-level retrieval facade.
 *
 * Orchestrates the retrieval pipeline:
 *   RetrievalGate -> HybridSearch -> Reranker -> ContextAssembler
 *
 * Delegates search logic to the existing HybridSearch class and
 * provides convenience methods (getNode, getPinnedNodes, search).
 *
 * Accepts a SqliteDatabase instance directly (no IPC).
 */

import type { SqliteDatabase } from './db-adapter.js';
import type {
  KnowledgeNode,
  MemoryConfig,
  MemoryTopic,
  NodeType,
  RetrievalResult,
} from './types.js';
import { DEFAULT_MEMORY_CONFIG } from './types.js';
import { HybridSearch } from './hybrid-search.js';
import { EmbeddingService } from './embedding-service.js';

/**
 * High-level memory retriever.
 *
 * Wraps HybridSearch with a simplified API for the common case.
 * Sources (when enabled):
 *   1. FTS5 full-text search (BM25 rank)
 *   2. Vector similarity (cosine) on embeddings
 *   3. Knowledge graph expansion (BFS from top results)
 *
 * Results use Stanford 3-factor scoring (recency x relevance x importance)
 * with weighted fusion across all retrieval sources.
 */
export class MemoryRetriever {
  private readonly hybridSearch: HybridSearch;
  private readonly config: MemoryConfig;

  constructor(
    db: SqliteDatabase,
    config?: Partial<MemoryConfig>,
    embeddingService?: EmbeddingService,
  ) {
    this.config = { ...DEFAULT_MEMORY_CONFIG, ...config };
    this.hybridSearch = new HybridSearch(db, config, embeddingService);
  }

  /** Whether the sqlite-vec knowledge_vec table is available for ANN search. */
  get vecAvailable(): boolean {
    return this.hybridSearch.vecAvailable;
  }

  /** Reset the cached vec availability flag (e.g., after loading sqlite-vec). */
  resetVecCache(): void {
    this.hybridSearch.resetVecCache();
  }

  /**
   * Set or replace the embedding service (allows lazy initialization).
   */
  setEmbeddingService(service: EmbeddingService): void {
    this.hybridSearch.setEmbeddingService(service);
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
    return this.hybridSearch.search(query, options);
  }

  /**
   * Get a single knowledge node by ID.
   */
  getNode(id: string): KnowledgeNode | null {
    return this.hybridSearch.getNode(id);
  }

  /**
   * Get all pinned knowledge nodes.
   */
  getPinnedNodes(topic?: MemoryTopic): KnowledgeNode[] {
    return this.hybridSearch.getPinnedNodes(topic);
  }

  /**
   * Access the underlying HybridSearch instance for pipeline integration.
   */
  getHybridSearch(): HybridSearch {
    return this.hybridSearch;
  }
}
