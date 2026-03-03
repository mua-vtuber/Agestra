/**
 * Reflection engine for Phase 3-b of the memory system.
 *
 * Periodically synthesizes accumulated knowledge nodes into higher-level
 * insights, inspired by Stanford Generative Agents. When enough new nodes
 * have accumulated since the last reflection, groups them by topic and
 * asks an LLM to identify patterns, relationships, and trends.
 *
 * The resulting insights are stored as new knowledge nodes with
 * `node_type = 'insight'` and `source = 'reflection'`, linked to their
 * source nodes via `derived_from` edges.
 */

import { randomUUID } from 'node:crypto';
import type { SqliteDatabase } from './db-adapter.js';
import type { MemoryConfig, MemoryTopic, ReflectionResult } from './types.js';
import { DEFAULT_MEMORY_CONFIG } from './types.js';
import { getMemoryEventBus } from './event-bus.js';

// -- Types ------------------------------------------------------------------

/** LLM function for reflection -- accepts prompt, returns text response. */
export type ReflectionLlmFn = (
  systemPrompt: string,
  userPrompt: string,
) => Promise<string>;

/** Raw row from knowledge_nodes for reflection queries. */
interface NodeRow {
  id: string;
  content: string;
  node_type: string;
  topic: string;
  importance: number;
  source: string;
  created_at: string;
}

// -- Prompts ----------------------------------------------------------------

const REFLECTION_SYSTEM_PROMPT = `You are a reflective AI assistant. Given a set of factual memories, synthesize higher-level insights.

For each group of related memories, generate insights that:
1. Identify patterns in behavior, interests, or preferences
2. Recognize relationships between concepts
3. Note trends over time
4. Summarize key learnings

Return a JSON array of insights. Each element must have:
- "content": the insight statement (string, 1-3 sentences)
- "importance": how significant this insight is, 0.5 to 1.0 (number)

Write insights in the same language as the source memories.
Return ONLY the JSON array. No markdown, no explanation.
If no meaningful insights can be drawn, return: []`;

// -- ReflectionEngine -------------------------------------------------------

/**
 * Generates higher-level insights from accumulated knowledge nodes.
 *
 * Triggered when the number of new nodes since the last reflection
 * exceeds the configured threshold. Groups recent nodes by topic,
 * sends each group to the LLM, and stores resulting insights as new
 * knowledge nodes with `node_type = 'insight'` and `source = 'reflection'`.
 */
export class ReflectionEngine {
  private readonly db: SqliteDatabase;
  private readonly llmFn: ReflectionLlmFn;
  private readonly config: MemoryConfig;

  constructor(
    db: SqliteDatabase,
    llmFn: ReflectionLlmFn,
    config?: Partial<MemoryConfig>,
  ) {
    this.db = db;
    this.llmFn = llmFn;
    this.config = { ...DEFAULT_MEMORY_CONFIG, ...config };
  }

  // -- Public Methods -------------------------------------------------------

  /**
   * Check whether enough new nodes have accumulated to trigger reflection.
   *
   * Counts nodes created after the most recent reflection insight.
   * Returns true when the count meets or exceeds `reflectionThreshold`.
   */
  shouldReflect(): boolean {
    const since = this.getLastReflectionTimestamp();
    const count = this.countNodesSince(since);
    return count >= this.config.reflectionThreshold;
  }

  /**
   * Run the reflection process.
   *
   * 1. Fetch recent non-reflection nodes since last reflection.
   * 2. Group by topic.
   * 3. For each topic group with >= reflectionMinGroupSize nodes, ask the LLM to synthesize insights.
   * 4. Store insight nodes and create `derived_from` edges.
   *
   * @returns The number of insights created and nodes processed.
   */
  async reflect(): Promise<ReflectionResult> {
    const since = this.getLastReflectionTimestamp();

    const recentNodes = this.getRecentNodes(since, 50);
    if (recentNodes.length < this.config.reflectionThreshold) {
      return { insightsCreated: 0, nodesProcessed: 0 };
    }

    const groups = this.groupByTopic(recentNodes);
    let totalInsights = 0;

    for (const [topic, nodes] of Object.entries(groups)) {
      if (nodes.length < this.config.reflectionMinGroupSize) {
        continue;
      }

      let insights: Array<{ content: string; importance: number }>;
      try {
        const raw = await this.generateInsights(nodes);
        insights = ReflectionEngine.parseInsights(raw);
      } catch (err: unknown) {
        getMemoryEventBus().emitError('reflection_failed', `Reflection failed for topic: ${topic}`, {
          error: err instanceof Error ? err : new Error(String(err)),
        });
        continue;
      }

      for (const insight of insights) {
        const insightId = this.storeInsightNode(
          insight.content,
          insight.importance,
          topic as MemoryTopic,
        );

        // Create derived_from edges to source nodes
        for (const sourceNode of nodes) {
          this.createEdge(insightId, sourceNode.id);
        }

        totalInsights++;
      }
    }

    return {
      insightsCreated: totalInsights,
      nodesProcessed: recentNodes.length,
    };
  }

  /**
   * Parse an LLM response string into an array of insight objects.
   *
   * Handles:
   * - Markdown code fences wrapping JSON
   * - Invalid JSON (returns empty array)
   * - Non-array JSON (returns empty array)
   * - Empty content filtering
   * - Importance clamping to [0.5, 1.0]
   */
  static parseInsights(
    raw: string,
  ): Array<{ content: string; importance: number }> {
    let text = raw.trim();

    // Strip markdown code fences if present
    if (text.startsWith('```')) {
      const firstNewline = text.indexOf('\n');
      if (firstNewline !== -1) {
        text = text.slice(firstNewline + 1);
      }
      if (text.endsWith('```')) {
        text = text.slice(0, -3).trim();
      }
    }

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return [];
    }

    if (!Array.isArray(data)) {
      return [];
    }

    const results: Array<{ content: string; importance: number }> = [];

    for (const item of data) {
      if (typeof item !== 'object' || item === null) {
        continue;
      }

      const record = item as Record<string, unknown>;
      const content =
        typeof record['content'] === 'string'
          ? record['content'].trim()
          : '';

      if (!content) {
        continue;
      }

      const rawImportance =
        typeof record['importance'] === 'number'
          ? record['importance']
          : 0.7;

      const importance = Math.max(0.5, Math.min(1.0, rawImportance));

      results.push({ content, importance });
    }

    return results;
  }

  // -- Private Helpers ------------------------------------------------------

  /**
   * Get the creation timestamp of the most recent reflection insight,
   * or a zero-epoch timestamp if no reflections have occurred.
   */
  private getLastReflectionTimestamp(): string {
    const row = this.db
      .prepare(
        `SELECT created_at
         FROM knowledge_nodes
         WHERE source = 'reflection'
           AND deleted_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get() as { created_at: string } | undefined;

    return row?.created_at ?? '1970-01-01T00:00:00.000Z';
  }

  /**
   * Count non-reflection nodes created after the given timestamp.
   */
  private countNodesSince(since: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt
         FROM knowledge_nodes
         WHERE created_at > ?
           AND source != 'reflection'
           AND deleted_at IS NULL`,
      )
      .get(since) as { cnt: number };

    return row.cnt;
  }

  /**
   * Fetch recent non-reflection nodes created after the given timestamp.
   */
  private getRecentNodes(since: string, limit: number): NodeRow[] {
    return this.db
      .prepare(
        `SELECT id, content, node_type, topic, importance, source, created_at
         FROM knowledge_nodes
         WHERE created_at > ?
           AND source != 'reflection'
           AND deleted_at IS NULL
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(since, limit) as NodeRow[];
  }

  /**
   * Group nodes by their topic field.
   */
  private groupByTopic(
    nodes: NodeRow[],
  ): Record<string, NodeRow[]> {
    const groups: Record<string, NodeRow[]> = {};
    for (const node of nodes) {
      const key = node.topic;
      if (!groups[key]) {
        groups[key] = [];
      }
      groups[key].push(node);
    }
    return groups;
  }

  /**
   * Ask the LLM to synthesize insights from a group of memory nodes.
   */
  private async generateInsights(nodes: NodeRow[]): Promise<string> {
    const memoriesText = nodes
      .map(
        (n) =>
          `- [${n.node_type}] ${n.content} (importance: ${n.importance})`,
      )
      .join('\n');

    const userPrompt =
      `Here are the accumulated memories to reflect on:\n\n` +
      `${memoriesText}\n\n` +
      `Generate higher-level insights from these memories.`;

    return this.llmFn(REFLECTION_SYSTEM_PROMPT, userPrompt);
  }

  /**
   * Store a single insight as a knowledge node.
   * FTS5 sync is handled automatically by the knowledge_fts_insert trigger.
   *
   * @returns The new node's ID.
   */
  private storeInsightNode(
    content: string,
    importance: number,
    topic: MemoryTopic,
  ): string {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO knowledge_nodes
         (id, content, node_type, topic, importance, source, pinned,
          last_accessed, created_at, updated_at)
         VALUES (?, ?, 'insight', ?, ?, 'reflection', 0, ?, ?, ?)`,
      )
      .run(id, content, topic, importance, now, now, now);

    return id;
  }

  /**
   * Create a `derived_from` edge from an insight node to a source node.
   */
  private createEdge(insightNodeId: string, sourceNodeId: string): void {
    this.db
      .prepare(
        `INSERT INTO knowledge_edges
         (id, source_node_id, target_node_id, relation_type, weight)
         VALUES (?, ?, ?, 'derived_from', 0.8)`,
      )
      .run(randomUUID(), insightNodeId, sourceNodeId);
  }
}
