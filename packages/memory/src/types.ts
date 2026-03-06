/**
 * Memory system type definitions.
 *
 * Phase 3-a: FTS5 + pin + regex extraction
 * Phase 3-b: embedding + hybrid search + reflection + evolution
 */

// ── Knowledge Node Types ────────────────────────────────────────────

/** Type of knowledge stored in a node. */
export type NodeType = 'fact' | 'decision' | 'preference' | 'insight' | 'dead_end' | 'finding';

/** Topic category for organizing knowledge. */
export type MemoryTopic = 'technical' | 'decisions' | 'preferences' | 'context';

/** How the knowledge was captured. */
export type MemorySource = 'auto' | 'pin' | 'reflection';

/** A knowledge node stored in the database. */
export interface KnowledgeNode {
  id: string;
  content: string;
  nodeType: NodeType;
  topic: MemoryTopic;
  importance: number;
  source: MemorySource;
  pinned: boolean;
  conversationId: string | null;
  messageId: string | null;
  lastAccessed: string | null;
  createdAt: string;
  updatedAt: string;
  /** Phase 3-b: embedding model version for re-indexing. */
  embeddingVersion: string | null;
  /** Phase 3-b: extractor version for re-extraction. */
  extractorVersion: string | null;
  /** Hash of source content for deduplication. */
  sourceHash: string | null;
  /** Deduplication key. */
  dedupeKey: string | null;
  /** Soft delete timestamp. */
  deletedAt: string | null;
  /** Speaker attribution — which AI provider produced this node. */
  providerId: string | null;
  /** Timestamp of the most recent re-mention in conversation. */
  lastMentionedAt: string | null;
  /** How many times this knowledge was re-mentioned. */
  mentionCount: number;
  /** Extraction confidence (0–1). Higher when produced by LLM extraction. */
  confidence: number;
}

/** Data required to create a new knowledge node. */
export interface KnowledgeNodeCreate {
  content: string;
  nodeType: NodeType;
  topic: MemoryTopic;
  importance: number;
  source: MemorySource;
  conversationId?: string;
  messageId?: string;
  sourceHash?: string;
  dedupeKey?: string;
  /** Speaker attribution. */
  providerId?: string;
  /** Extraction confidence (0–1). */
  confidence?: number;
}

// ── Knowledge Edge Types ────────────────────────────────────────────

/** Relationship type between knowledge nodes. */
export type RelationType =
  | 'related_to'
  | 'contradicts'
  | 'supersedes'
  | 'depends_on'
  | 'merged_from'
  | 'derived_from';

/** An edge in the knowledge graph. */
export interface KnowledgeEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  relationType: RelationType;
  weight: number;
  createdAt: string;
}

// ── Retrieval Types ─────────────────────────────────────────────────

/** A scored retrieval result from the memory system. */
export interface RetrievalResult {
  node: KnowledgeNode;
  score: number;
  source: 'fts' | 'vector' | 'graph';
}

/** Scoring weights for the 3-factor model. */
export interface ScoringWeights {
  recency: number;
  relevance: number;
  importance: number;
}

/** Default scoring weights (Stanford Generative Agents). */
export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  recency: 0.3,
  relevance: 0.5,
  importance: 0.2,
};

// ── Extraction Types ────────────────────────────────────────────────

/** Pattern category for extraction rule matching. */
export type PatternCategory = 'decision' | 'preference' | 'fact' | 'tech_decision';

/** An item extracted from conversation text. */
export interface ExtractionItem {
  content: string;
  nodeType: NodeType;
  topic: MemoryTopic;
  importance: number;
  /** Speaker attribution from the source message. */
  providerId?: string;
  /** Extraction confidence (0–1). */
  confidence?: number;
}

/** Result of an extraction pass. */
export interface ExtractionResult {
  items: ExtractionItem[];
  turnCount: number;
}

// ── Context Assembly Types ──────────────────────────────────────────

/** Budget allocation ratios for context assembly. */
export interface ContextBudgetRatios {
  systemPrompt: number;
  memories: number;
  recentHistory: number;
  responseReserve: number;
}

/** Default budget ratios as specified in design doc. */
export const DEFAULT_BUDGET_RATIOS: ContextBudgetRatios = {
  systemPrompt: 0.15,
  memories: 0.25,
  recentHistory: 0.50,
  responseReserve: 0.10,
};

/** Assembled context ready for prompt construction. */
export interface AssembledContext {
  memoryContext: string;
  tokensUsed: number;
}

// ── Embedding Types (Phase 3-b) ─────────────────────────────────────

/** Interface for embedding text into vectors. */
export interface EmbeddingProvider {
  /** Generate an embedding vector for the given text. */
  embed(text: string): Promise<number[] | null>;
  /** The model identifier (for versioning/re-indexing). */
  readonly modelId: string;
  /** Embedding dimension. */
  readonly dimension: number;
}

/** Fusion weights for combining multi-source retrieval results. */
export interface FusionWeights {
  vector: number;
  fts: number;
  graph: number;
}

/** Default fusion weights. */
export const DEFAULT_FUSION_WEIGHTS: FusionWeights = {
  vector: 0.5,
  fts: 0.3,
  graph: 0.2,
};

// ── Memory Config ───────────────────────────────────────────────────

/** Configuration for the memory system. */
export interface MemoryConfig {
  /** Total token budget for context assembly. */
  contextTotalBudget: number;
  /** Budget allocation ratios. */
  budgetRatios: ContextBudgetRatios;
  /** Scoring weights for retrieval. */
  scoringWeights: ScoringWeights;
  /** Half-life in days for recency decay. */
  recencyHalfLifeDays: number;
  /** Maximum number of retrieval results. */
  retrievalLimit: number;
  /** Minimum importance threshold for auto-extraction. */
  extractionMinImportance: number;
  /** Enable FTS5 search. */
  ftsEnabled: boolean;

  // ── Phase 3-b fields ────────────────────────────────────────────
  /** Enable vector search (requires EmbeddingProvider). */
  vectorEnabled: boolean;
  /** Enable knowledge graph expansion. */
  graphEnabled: boolean;
  /** Fusion weights for multi-source retrieval. */
  fusionWeights: FusionWeights;
  /** Maximum hops for knowledge graph expansion. */
  graphMaxHops: number;
  /** Cosine similarity threshold for merging nodes (0-1). */
  mergeSimilarityThreshold: number;
  /** Maximum candidates to consider per merge pass. */
  mergeMaxCandidates: number;
  /** Importance threshold below which stale nodes can be pruned. */
  pruneImportanceThreshold: number;
  /** Minimum new nodes since last reflection to trigger reflection. */
  reflectionThreshold: number;

  // ── Pin-related (previously hardcoded) ─────────────────────────
  /** Importance boost when pinning an existing node. */
  pinImportanceBoost: number;
  /** Default importance for newly pinned nodes. */
  pinDefaultImportance: number;
  /** Score multiplier for pinned nodes in search results. */
  pinSearchBoost: number;

  // ── FTS/Retrieval tuning ───────────────────────────────────────
  /** FTS relevance floor (minimum normalized relevance). */
  ftsRelevanceFloor: number;
  /** Graph hop decay factor per hop. */
  graphHopDecay: number;
  /** Minimum top L2 score to skip L3 graph expansion (0-1). */
  graphSkipThreshold: number;

  // ── Importance thresholds ──────────────────────────────────────
  /** Nodes with importance >= this get a [important] marker in context. */
  importanceHighThreshold: number;

  // ── Reflection tuning ──────────────────────────────────────────
  /** Minimum nodes in a topic group to include in reflection. */
  reflectionMinGroupSize: number;

  // ── Token safety ───────────────────────────────────────────────
  /** Safety margin ratio for token estimation (0-1). 0.9 = use 90% of budget. */
  tokenSafetyMargin: number;

  // ── Extraction ─────────────────────────────────────────────────
  /** LLM extraction provider ID. null = regex only. */
  extractionLlmProviderId: string | null;
  /** Default importance per extraction category. */
  categoryImportance: Record<PatternCategory, number>;

  // ── Re-mention ─────────────────────────────────────────────────
  /** Importance boost per re-mention occurrence. */
  mentionBoostPerCount: number;
  /** Maximum total boost from re-mentions. */
  mentionBoostCap: number;

  // ── Prompt templates ───────────────────────────────────────────
  /** Header text for memory context block. */
  memoryContextHeader: string;
  /** Marker text appended to high-importance memories. */
  importanceMarkerText: string;
}

/** Default memory configuration. */
export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  contextTotalBudget: 4096,
  budgetRatios: DEFAULT_BUDGET_RATIOS,
  scoringWeights: DEFAULT_SCORING_WEIGHTS,
  recencyHalfLifeDays: 30,
  retrievalLimit: 10,
  extractionMinImportance: 0.3,
  ftsEnabled: true,
  vectorEnabled: false,
  graphEnabled: false,
  fusionWeights: DEFAULT_FUSION_WEIGHTS,
  graphMaxHops: 2,
  mergeSimilarityThreshold: 0.85,
  mergeMaxCandidates: 200,
  pruneImportanceThreshold: 0.2,
  reflectionThreshold: 10,
  pinImportanceBoost: 0.2,
  pinDefaultImportance: 0.7,
  pinSearchBoost: 1.2,
  ftsRelevanceFloor: 0.3,
  graphHopDecay: 0.7,
  graphSkipThreshold: 0.7,
  importanceHighThreshold: 0.8,
  reflectionMinGroupSize: 3,
  tokenSafetyMargin: 0.9,
  extractionLlmProviderId: null,
  categoryImportance: {
    decision: 0.7,
    preference: 0.5,
    fact: 0.5,
    tech_decision: 0.6,
  },
  mentionBoostPerCount: 0.05,
  mentionBoostCap: 0.1,
  memoryContextHeader: '[관련 기억]',
  importanceMarkerText: ' [중요]',
};

// ── Evolution Types (Phase 3-b) ─────────────────────────────────────

/** Result of a memory evolution pass. */
export interface EvolutionResult {
  merged: number;
  pruned: number;
}

/** Result of a reflection pass. */
export interface ReflectionResult {
  insightsCreated: number;
  nodesProcessed: number;
}

// ── Pin Types ───────────────────────────────────────────────────────

/** Request to pin a message to memory. */
export interface PinRequest {
  messageId: string;
  topic: MemoryTopic;
}

/** Memory search request. */
export interface MemorySearchRequest {
  query: string;
  topic?: MemoryTopic;
  limit?: number;
}

/** Memory search result for IPC transport. */
export interface MemorySearchResult {
  id: string;
  content: string;
  nodeType: NodeType;
  topic: MemoryTopic;
  importance: number;
  score: number;
  pinned: boolean;
  createdAt: string;
}

// ── Retrieval Pipeline Types ────────────────────────────────────────

/** Input/output data flowing through the retrieval pipeline. */
export interface RetrievalPipelineData {
  query: string;
  topic?: MemoryTopic;
  nodeType?: NodeType;
  limit?: number;
  /** Populated by HybridSearch stage. */
  results: RetrievalResult[];
}
