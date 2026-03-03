/**
 * Storage pipeline stages: ProviderTagger, ReMentionDetector, ConflictChecker.
 *
 * These stages run after extraction and before final storage:
 *   ExtractionStage -> ProviderTagger -> ReMentionDetector -> ConflictChecker -> StorageStage
 */

import { randomUUID, createHash } from 'node:crypto';
import type { SqliteDatabase } from './db-adapter.js';
import type { ExtractionItem, MemoryConfig } from './types.js';
import { DEFAULT_MEMORY_CONFIG } from './types.js';
import type { PipelineStage, AnnotatedMessage } from './pipeline.js';

// -- Shared Types --

/** Items enriched with storage metadata, flowing through the storage pipeline. */
export interface StoragePipelineData {
  items: EnrichedExtractionItem[];
  messages: AnnotatedMessage[];
  conversationId?: string;
}

/**
 * ExtractionItem extended with optional conflict metadata.
 * The _conflictsWith field is set by ConflictChecker for items
 * that conflict with existing knowledge nodes.
 */
export interface EnrichedExtractionItem extends ExtractionItem {
  /** Internal: ID of conflicting existing node (set by ConflictChecker). */
  _conflictsWith?: string;
}

/** Result after storage pipeline completes. */
export interface StorageResult {
  stored: number;
  skipped: number;
  mentions: number;
  conflicts: number;
}

// -- ProviderTagger --

/**
 * Ensures every extraction item has a providerId assigned.
 *
 * Items already tagged by the extraction strategy (LlmStrategy) pass
 * through unchanged. Items from RegexStrategy get provider_id from
 * the message they were extracted from.
 *
 * This is a pass-through identity stage since ExtractionStrategy
 * already handles attribution. Kept as an explicit pipeline stage
 * for clarity and future extension (e.g., multi-speaker resolution).
 */
export class ProviderTagger implements PipelineStage<StoragePipelineData, StoragePipelineData> {
  readonly name = 'ProviderTagger';

  async execute(input: StoragePipelineData): Promise<StoragePipelineData> {
    // Items should already have providerId from the strategy.
    // This stage validates and fills any gaps from the message list.
    const providerIds = new Map<string, string>();
    for (const msg of input.messages) {
      // Map content fragments to provider IDs for fallback matching
      providerIds.set(msg.content.slice(0, 100), msg.providerId);
    }

    const items = input.items.map((item) => {
      if (item.providerId) return item;

      // Fallback: try to match by content prefix
      for (const [prefix, pid] of providerIds) {
        if (item.content.includes(prefix.slice(0, 30))) {
          return { ...item, providerId: pid };
        }
      }

      return item;
    });

    return { ...input, items };
  }
}

// -- ReMentionDetector --

/**
 * Detects re-mentions of existing knowledge and updates mention_count.
 *
 * For each extraction item:
 * 1. Check dedupe_key match -> exact duplicate, bump mention_count
 * 2. No match -> new item (keep in pipeline)
 *
 * Re-mentioned items are removed from the pipeline (already stored),
 * but their mention_count and importance are updated in DB.
 */
export class ReMentionDetector implements PipelineStage<StoragePipelineData, StoragePipelineData> {
  readonly name = 'ReMentionDetector';
  private readonly db: SqliteDatabase;
  private readonly config: MemoryConfig;

  constructor(db: SqliteDatabase, config?: Partial<MemoryConfig>) {
    this.db = db;
    this.config = { ...DEFAULT_MEMORY_CONFIG, ...config };
  }

  async execute(input: StoragePipelineData): Promise<StoragePipelineData | null> {
    const newItems: EnrichedExtractionItem[] = [];

    const updateStmt = this.db.prepare(
      `UPDATE knowledge_nodes
       SET mention_count = mention_count + 1,
           last_mentioned_at = ?,
           importance = MIN(1.0, importance + ?),
           updated_at = ?
       WHERE id = ? AND deleted_at IS NULL`,
    );

    for (const item of input.items) {
      const dedupeKey = this.computeDedupeKey(item.content);

      // 1. Check exact dedup match
      const existing = this.db.prepare(
        `SELECT id, importance, mention_count FROM knowledge_nodes
         WHERE dedupe_key = ? AND deleted_at IS NULL LIMIT 1`,
      ).get(dedupeKey) as { id: string; importance: number; mention_count: number } | undefined;

      if (existing) {
        const now = new Date().toISOString();
        const boost = Math.min(
          this.config.mentionBoostCap,
          this.config.mentionBoostPerCount * (existing.mention_count + 1),
        );
        updateStmt.run(now, boost, now, existing.id);
        continue; // Skip -- already stored
      }

      // 2. No match -> new item
      newItems.push(item);
    }

    if (newItems.length === 0) {
      return null; // All items were re-mentions
    }

    return { ...input, items: newItems };
  }

  private computeDedupeKey(content: string): string {
    const normalized = content.trim().toLowerCase().replace(/\s+/g, ' ');
    return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  }
}

// -- ConflictChecker --

/**
 * Detects contradictions with existing knowledge.
 *
 * When a new decision node conflicts with an existing decision
 * in the same topic, creates:
 * - `contradicts` edge between the two nodes
 * - `supersedes` edge (new supersedes old, based on time)
 *
 * Phase 3-a: keyword-based comparison within same topic + node_type.
 * Phase 3-b: can be enhanced with LLM-based contradiction detection.
 */
export class ConflictChecker implements PipelineStage<StoragePipelineData, StoragePipelineData> {
  readonly name = 'ConflictChecker';
  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  async execute(input: StoragePipelineData): Promise<StoragePipelineData> {
    // Only check decision-type items for conflicts
    for (const item of input.items) {
      if (item.nodeType !== 'decision') continue;

      const conflicting = this.findConflictingDecision(item);
      if (conflicting) {
        // Mark the item for conflict edge creation after storage
        item._conflictsWith = conflicting.id;
      }
    }

    return input;
  }

  /**
   * Find an existing decision node in the same topic that might
   * conflict with the new item. Uses keyword overlap heuristic.
   */
  private findConflictingDecision(
    item: EnrichedExtractionItem,
  ): { id: string; content: string } | null {
    // Search for existing decisions in the same topic
    const rows = this.db.prepare(
      `SELECT id, content FROM knowledge_nodes
       WHERE node_type = 'decision'
         AND topic = ?
         AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT 20`,
    ).all(item.topic) as Array<{ id: string; content: string }>;

    if (rows.length === 0) return null;

    // Extract significant keywords from the new item
    const newKeywords = this.extractKeywords(item.content);
    if (newKeywords.size === 0) return null;

    for (const row of rows) {
      const existingKeywords = this.extractKeywords(row.content);
      const overlap = this.keywordOverlap(newKeywords, existingKeywords);

      // If there's significant keyword overlap but different content,
      // it might be a conflicting decision about the same topic
      if (overlap >= 0.3 && !this.isSameContent(item.content, row.content)) {
        return row;
      }
    }

    return null;
  }

  /** Extract significant words (>2 chars, lowercased). */
  private extractKeywords(text: string): Set<string> {
    return new Set(
      text.toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, '')
        .split(/\s+/)
        .filter((w) => w.length > 2),
    );
  }

  /** Jaccard similarity between two keyword sets. */
  private keywordOverlap(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let intersection = 0;
    for (const word of a) {
      if (b.has(word)) intersection++;
    }
    const union = a.size + b.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  /** Check if two texts are essentially the same content. */
  private isSameContent(a: string, b: string): boolean {
    const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
    return normalize(a) === normalize(b);
  }
}

// -- StorageStage --

/**
 * Final storage stage: writes remaining items to the database.
 *
 * Creates knowledge_nodes rows, generates dedupe keys, queues
 * async embedding, and creates conflict edges if marked by ConflictChecker.
 */
export class StorageStage implements PipelineStage<StoragePipelineData, StorageResult> {
  readonly name = 'StorageStage';
  private readonly db: SqliteDatabase;
  private readonly config: MemoryConfig;

  constructor(db: SqliteDatabase, config?: Partial<MemoryConfig>) {
    this.db = db;
    this.config = { ...DEFAULT_MEMORY_CONFIG, ...config };
  }

  async execute(input: StoragePipelineData): Promise<StorageResult> {
    let stored = 0;
    let skipped = 0;
    let conflicts = 0;

    for (const item of input.items) {
      if (item.importance < this.config.extractionMinImportance) {
        skipped++;
        continue;
      }

      const normalized = item.content.trim().toLowerCase().replace(/\s+/g, ' ');
      const dedupeKey = createHash('sha256').update(normalized).digest('hex').slice(0, 16);

      // Skip duplicates
      const existing = this.db.prepare(
        'SELECT 1 FROM knowledge_nodes WHERE dedupe_key = ? AND deleted_at IS NULL LIMIT 1',
      ).get(dedupeKey);
      if (existing !== undefined) {
        skipped++;
        continue;
      }

      const id = randomUUID();
      const now = new Date().toISOString();
      const sourceHash = createHash('sha256').update(item.content).digest('hex');

      this.db.prepare(
        `INSERT INTO knowledge_nodes
         (id, content, node_type, topic, importance, source, pinned,
          conversation_id, last_accessed, created_at, updated_at,
          source_hash, dedupe_key, provider_id, confidence)
         VALUES (?, ?, ?, ?, ?, 'auto', 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        item.content,
        item.nodeType,
        item.topic,
        item.importance,
        input.conversationId ?? null,
        now, now, now,
        sourceHash,
        dedupeKey,
        item.providerId ?? null,
        item.confidence ?? 0.5,
      );

      stored++;

      // Create conflict edge if marked
      if (item._conflictsWith) {
        const edgeId = randomUUID();
        this.db.prepare(
          `INSERT INTO knowledge_edges (id, source_node_id, target_node_id, relation_type, weight)
           VALUES (?, ?, ?, 'contradicts', 1.0)`,
        ).run(edgeId, id, item._conflictsWith);

        const supersedesId = randomUUID();
        this.db.prepare(
          `INSERT INTO knowledge_edges (id, source_node_id, target_node_id, relation_type, weight)
           VALUES (?, ?, ?, 'supersedes', 1.0)`,
        ).run(supersedesId, id, item._conflictsWith);

        conflicts++;
      }
    }

    return { stored, skipped, mentions: 0, conflicts };
  }
}
