/**
 * Regex-based memory extraction from conversation text.
 *
 * Phase 3-a: Extracts decisions, preferences, facts, and technical
 * decisions using pattern matching (no LLM dependency).
 * Supports Korean and English content.
 */

import type {
  ExtractionItem,
  ExtractionResult,
  MemoryConfig,
  MemoryTopic,
  NodeType,
  PatternCategory,
} from './types.js';
import { DEFAULT_MEMORY_CONFIG } from './types.js';

// -- Pattern Definition --

interface PatternDef {
  pattern: RegExp;
  category: PatternCategory;
}

/** Mapping from category to ExtractionItem fields. */
const CATEGORY_MAP: Record<
  PatternCategory,
  { nodeType: NodeType; topic: MemoryTopic; importance: number }
> = {
  decision: { nodeType: 'decision', topic: 'decisions', importance: 0.7 },
  preference: { nodeType: 'preference', topic: 'preferences', importance: 0.5 },
  fact: { nodeType: 'fact', topic: 'technical', importance: 0.5 },
  tech_decision: { nodeType: 'decision', topic: 'technical', importance: 0.6 },
};

// -- Korean Patterns --

const KOREAN_DECISION_PATTERNS: PatternDef[] = [
  { pattern: /(으)?로 결정/u, category: 'decision' },
  { pattern: /(으)?로 가기로 했/u, category: 'decision' },
  { pattern: /[을를] 쓰기로 했/u, category: 'decision' },
  { pattern: /[을를] 사용하기로/u, category: 'decision' },
  { pattern: /하기로 합의/u, category: 'decision' },
];

const KOREAN_PREFERENCE_PATTERNS: PatternDef[] = [
  { pattern: /[을를] 추천/u, category: 'preference' },
  { pattern: /[이가] 좋겠/u, category: 'preference' },
  { pattern: /[을를] 선호/u, category: 'preference' },
  { pattern: /[을를] 쓰자/u, category: 'preference' },
  { pattern: /[이가] 낫다/u, category: 'preference' },
  { pattern: /[이가] 더 좋/u, category: 'preference' },
];

const KOREAN_FACT_PATTERNS: PatternDef[] = [
  { pattern: /[은는] .+이다/u, category: 'fact' },
  { pattern: /[을를] 지원한다/u, category: 'fact' },
  { pattern: /[이가] 필요하다/u, category: 'fact' },
  { pattern: /의 장점은/u, category: 'fact' },
  { pattern: /의 단점은/u, category: 'fact' },
];

const KOREAN_TECH_PATTERNS: PatternDef[] = [
  { pattern: /\S+\s*버전/u, category: 'tech_decision' },
  { pattern: /\S+\s*프레임워크/u, category: 'tech_decision' },
  { pattern: /\S+\s*라이브러리/u, category: 'tech_decision' },
  { pattern: /\S+\s*아키텍처/u, category: 'tech_decision' },
];

// -- English Patterns --

const ENGLISH_DECISION_PATTERNS: PatternDef[] = [
  { pattern: /decided to\b/i, category: 'decision' },
  { pattern: /agreed on\b/i, category: 'decision' },
  { pattern: /let'?s use\b/i, category: 'decision' },
  { pattern: /we'?ll go with\b/i, category: 'decision' },
  { pattern: /settled on\b/i, category: 'decision' },
];

const ENGLISH_PREFERENCE_PATTERNS: PatternDef[] = [
  { pattern: /\bprefer\b/i, category: 'preference' },
  { pattern: /\brecommend\b/i, category: 'preference' },
  { pattern: /\bbetter to\b/i, category: 'preference' },
  { pattern: /\bshould use\b/i, category: 'preference' },
  { pattern: /let'?s go with\b/i, category: 'preference' },
];

const ENGLISH_FACT_PATTERNS: PatternDef[] = [
  { pattern: /\bsupports\b/i, category: 'fact' },
  { pattern: /\brequires\b/i, category: 'fact' },
  { pattern: /\badvantage of\b/i, category: 'fact' },
  { pattern: /\bdisadvantage of\b/i, category: 'fact' },
];

/** All patterns consolidated in order of priority. */
const ALL_PATTERNS: PatternDef[] = [
  // Decisions first (higher priority than preference for overlapping "let's go with")
  ...KOREAN_DECISION_PATTERNS,
  ...ENGLISH_DECISION_PATTERNS,
  // Preferences
  ...KOREAN_PREFERENCE_PATTERNS,
  ...ENGLISH_PREFERENCE_PATTERNS,
  // Facts
  ...KOREAN_FACT_PATTERNS,
  ...ENGLISH_FACT_PATTERNS,
  // Tech decisions
  ...KOREAN_TECH_PATTERNS,
];

// -- Sentence Splitting --

/**
 * Split text into sentences using period, question mark, exclamation mark,
 * or newline as delimiters.
 */
function splitSentences(text: string): string[] {
  // Split on sentence-ending punctuation or newlines.
  // Keeps Korean period (.) and common sentence enders.
  const raw = text.split(/(?<=[.?!\n])\s*/);
  const sentences: string[] = [];

  for (const s of raw) {
    const trimmed = s.trim();
    if (trimmed.length > 0) {
      sentences.push(trimmed);
    }
  }

  return sentences;
}

// -- RegexExtractor --

/**
 * Extracts important facts, decisions, and preferences from conversation
 * text using regex pattern matching.
 *
 * Phase 3-a implementation: no LLM dependency, purely rule-based.
 */
export class RegexExtractor {
  private readonly categoryImportance: Record<PatternCategory, number>;

  constructor(config?: Partial<MemoryConfig>) {
    this.categoryImportance = config?.categoryImportance ?? DEFAULT_MEMORY_CONFIG.categoryImportance;
  }

  /**
   * Extract items from a single text block.
   *
   * Splits the text into sentences, matches each sentence against
   * all known patterns, and returns deduplicated ExtractionItem[].
   */
  extract(text: string): ExtractionItem[] {
    if (!text || text.trim().length === 0) {
      return [];
    }

    const sentences = splitSentences(text);
    const items: ExtractionItem[] = [];
    const seen = new Set<string>();

    for (const sentence of sentences) {
      const matched = this.matchSentence(sentence);
      if (matched && !seen.has(matched.content)) {
        seen.add(matched.content);
        items.push(matched);
      }
    }

    return items;
  }

  /**
   * Extract items from multiple messages.
   *
   * Deduplicates across all messages and returns an ExtractionResult.
   */
  extractFromMessages(
    messages: Array<{ content: string; providerId: string }>,
  ): ExtractionResult {
    const allItems: ExtractionItem[] = [];
    const seen = new Set<string>();

    for (const msg of messages) {
      const items = this.extract(msg.content);
      for (const item of items) {
        if (!seen.has(item.content)) {
          seen.add(item.content);
          allItems.push(item);
        }
      }
    }

    return {
      items: allItems,
      turnCount: messages.length,
    };
  }

  // -- Private helpers --

  /**
   * Match a single sentence against all patterns.
   * Returns the first match found (priority order), or null.
   */
  private matchSentence(sentence: string): ExtractionItem | null {
    for (const def of ALL_PATTERNS) {
      if (def.pattern.test(sentence)) {
        const mapping = CATEGORY_MAP[def.category];
        return {
          content: sentence,
          nodeType: mapping.nodeType,
          topic: mapping.topic,
          importance: this.categoryImportance[def.category] ?? mapping.importance,
        };
      }
    }
    return null;
  }
}
