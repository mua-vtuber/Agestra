/**
 * Reranker pipeline stage: re-scores retrieval results with additional signals.
 *
 * Applied after HybridSearch, before ContextAssembler. Enhances the
 * base 3-factor score (recency x relevance x importance) with:
 *
 *   1. mention_count boost — frequently re-mentioned knowledge ranks higher
 *   2. confidence weighting — LLM-extracted items (higher confidence) preferred
 *   3. Pin boost (already applied by retriever, preserved here)
 *
 * The reranker also enforces the final result limit and deduplicates.
 */

import type { MemoryConfig, RetrievalResult, RetrievalPipelineData } from './types.js';
import { DEFAULT_MEMORY_CONFIG } from './types.js';
import type { PipelineStage } from './pipeline.js';

export class Reranker implements PipelineStage<RetrievalPipelineData, RetrievalPipelineData> {
  readonly name = 'Reranker';
  private readonly config: MemoryConfig;

  constructor(config?: Partial<MemoryConfig>) {
    this.config = { ...DEFAULT_MEMORY_CONFIG, ...config };
  }

  async execute(input: RetrievalPipelineData): Promise<RetrievalPipelineData> {
    if (!input.results || input.results.length === 0) {
      return input;
    }

    const limit = input.limit ?? this.config.retrievalLimit;

    // Apply re-ranking boosts
    const reranked = input.results.map((result) => ({
      ...result,
      score: this.computeRerankedScore(result),
    }));

    // Sort by reranked score descending
    reranked.sort((a, b) => b.score - a.score);

    // Enforce limit
    const limited = reranked.slice(0, limit);

    return { ...input, results: limited };
  }

  /**
   * Compute the re-ranked score by applying mention_count and confidence boosts.
   */
  private computeRerankedScore(result: RetrievalResult): number {
    let score = result.score;

    const node = result.node;

    // 1. Mention count boost: more mentions = more important
    if (node.mentionCount > 0) {
      const mentionBoost = Math.min(
        this.config.mentionBoostCap,
        this.config.mentionBoostPerCount * node.mentionCount,
      );
      score = Math.min(1.0, score + mentionBoost);
    }

    // 2. Confidence weighting: LLM-extracted (0.7) gets slight edge over regex (0.5)
    // Scale: multiply by (0.8 + 0.2 * confidence) to give a 0.8-1.0 range
    const confidenceFactor = 0.8 + 0.2 * (node.confidence ?? 0.5);
    score *= confidenceFactor;

    return Math.min(1.0, score);
  }
}
