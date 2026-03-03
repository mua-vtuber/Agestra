/**
 * RetrievalGate pipeline stage: decides if a query needs memory search.
 *
 * Filters out queries that are unlikely to benefit from memory retrieval:
 *   - Very short queries (< minWords)
 *   - Greetings and pleasantries
 *   - Command-like inputs
 *
 * Phase 3-a: rule-based (length, keyword matching).
 * Phase 3-b: can be enhanced with LLM-based intent classification.
 */

import type { MemoryConfig, RetrievalPipelineData } from './types.js';
import type { PipelineStage } from './pipeline.js';

/** Patterns that indicate the query does not need memory search. */
const SKIP_PATTERNS: RegExp[] = [
  // Greetings (Korean + English)
  /^(안녕|하이|헬로|hello|hi|hey|yo|good\s*(morning|afternoon|evening))[\s!.?]*$/i,
  // Short affirmations / filler
  /^(네|예|응|ㅇㅇ|ㅋ+|ㅎ+|ok|okay|yes|no|nah|yep|nope|sure|thanks|고마워|감사|ㄱㅅ)[\s!.?]*$/i,
  // Command-like (slash commands, etc.)
  /^\//,
];

/**
 * Minimum word count to consider a query worth searching.
 * Queries with fewer words than this are skipped.
 */
const DEFAULT_MIN_WORDS = 2;

export class RetrievalGate implements PipelineStage<RetrievalPipelineData, RetrievalPipelineData> {
  readonly name = 'RetrievalGate';
  private readonly minWords: number;

  constructor(_config?: Partial<MemoryConfig>) {
    this.minWords = DEFAULT_MIN_WORDS;
  }

  async execute(input: RetrievalPipelineData): Promise<RetrievalPipelineData | null> {
    if (this.shouldSkip(input.query)) {
      return null; // Short-circuit -- no search needed
    }
    return input;
  }

  /**
   * Determine if a query should skip memory search.
   */
  shouldSkip(query: string): boolean {
    const trimmed = query.trim();

    // Empty or whitespace-only
    if (trimmed.length === 0) return true;

    // Too short (word count)
    const words = trimmed.split(/\s+/).filter((w) => w.length > 0);
    if (words.length < this.minWords) return true;

    // Matches skip patterns
    for (const pattern of SKIP_PATTERNS) {
      if (pattern.test(trimmed)) return true;
    }

    return false;
  }
}
