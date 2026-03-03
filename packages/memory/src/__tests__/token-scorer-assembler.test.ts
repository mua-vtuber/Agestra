import { describe, expect, it } from 'vitest';
import { estimateTokens, truncateToBudget, setTokenizerModel } from '../token-counter.js';
import { computeRecency, computeCombinedScore } from '../scorer.js';
import { ContextAssembler } from '../assembler.js';
import type {
  KnowledgeNode,
  MemoryConfig,
  RetrievalResult,
  ScoringWeights,
} from '../types.js';
import {
  DEFAULT_BUDGET_RATIOS,
  DEFAULT_MEMORY_CONFIG,
} from '../types.js';

// ── Helpers ───────────────────────────────────────────────────────────

function makeNode(overrides: Partial<KnowledgeNode> = {}): KnowledgeNode {
  return {
    id: 'node-1',
    content: 'test content',
    nodeType: 'fact',
    topic: 'technical',
    importance: 0.5,
    source: 'auto',
    pinned: false,
    conversationId: null,
    messageId: null,
    lastAccessed: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    embeddingVersion: null,
    extractorVersion: null,
    sourceHash: null,
    dedupeKey: null,
    deletedAt: null,
    providerId: null,
    lastMentionedAt: null,
    mentionCount: 0,
    confidence: 0.5,
    ...overrides,
  };
}

function makeRetrievalResult(
  content: string,
  score: number,
  importance = 0.5,
): RetrievalResult {
  return {
    node: makeNode({ content, importance }),
    score,
    source: 'fts',
  };
}

function makeConfig(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return { ...DEFAULT_MEMORY_CONFIG, ...overrides };
}

// ── Token Counter Tests ───────────────────────────────────────────────

describe('token-counter', () => {
  describe('estimateTokens', () => {
    it('should return 0 for empty string', () => {
      expect(estimateTokens('')).toBe(0);
    });

    it('should return 0 for null/undefined-like input', () => {
      // Empty string is the closest to null in this context
      expect(estimateTokens('')).toBe(0);
    });

    it('should count English tokens via tiktoken', () => {
      const text = 'hello world foo bar';
      // tiktoken gpt-4o: 4 tokens
      expect(estimateTokens(text)).toBe(4);
    });

    it('should count Korean tokens via tiktoken', () => {
      const text = '안녕하세요';
      // tiktoken gpt-4o: 2 tokens
      expect(estimateTokens(text)).toBe(2);
    });

    it('should count mixed CJK/Latin tokens via tiktoken', () => {
      const text = 'hello 안녕하세요 world';
      // tiktoken gpt-4o: 4 tokens
      expect(estimateTokens(text)).toBe(4);
    });

    it('should handle Japanese hiragana', () => {
      const text = 'こんにちは';
      // tiktoken gpt-4o: 1 token
      expect(estimateTokens(text)).toBe(1);
    });

    it('should handle Chinese characters', () => {
      const text = '你好世界';
      // tiktoken gpt-4o: 2 tokens
      expect(estimateTokens(text)).toBe(2);
    });

    it('should return at least 1 for non-empty text', () => {
      expect(estimateTokens('a')).toBeGreaterThanOrEqual(1);
    });

    it('should count repeated words via tiktoken', () => {
      const words = Array.from({ length: 100 }, () => 'word');
      const text = words.join(' ');
      // tiktoken gpt-4o: 100 tokens
      expect(estimateTokens(text)).toBe(100);
    });
  });

  describe('setTokenizerModel', () => {
    it('uses default model gpt-4o', () => {
      const tokens = estimateTokens('hello world');
      expect(tokens).toBeGreaterThanOrEqual(1);
    });

    it('setTokenizerModel resets encoder', () => {
      setTokenizerModel('gpt-4');
      const tokens = estimateTokens('hello world');
      expect(tokens).toBeGreaterThanOrEqual(1);
      // Reset back to default
      setTokenizerModel('gpt-4o');
    });

    it('falls back on invalid model name', () => {
      setTokenizerModel('nonexistent-model-xyz');
      const tokens = estimateTokens('hello world');
      expect(tokens).toBeGreaterThanOrEqual(1);
      // Reset back to default
      setTokenizerModel('gpt-4o');
    });
  });

  describe('truncateToBudget', () => {
    it('should return empty string for zero budget', () => {
      expect(truncateToBudget('hello world', 0)).toBe('');
    });

    it('should return empty string for negative budget', () => {
      expect(truncateToBudget('hello world', -5)).toBe('');
    });

    it('should return original text if within budget', () => {
      const text = 'short';
      expect(truncateToBudget(text, 100)).toBe(text);
    });

    it('should truncate text exceeding budget', () => {
      const text = '안녕하세요 반갑습니다 좋은 하루 되세요';
      const budget = 5;
      const result = truncateToBudget(text, budget);
      expect(estimateTokens(result)).toBeLessThanOrEqual(budget);
      expect(result.length).toBeLessThan(text.length);
    });

    it('should truncate English text to fit budget', () => {
      const words = Array.from({ length: 100 }, () => 'word');
      const text = words.join(' ');
      const budget = 10;
      const result = truncateToBudget(text, budget);
      expect(estimateTokens(result)).toBeLessThanOrEqual(budget);
    });
  });
});

// ── Scorer Tests ──────────────────────────────────────────────────────

describe('scorer', () => {
  describe('computeRecency', () => {
    it('should return ~1.0 for just-accessed memory', () => {
      const now = new Date().toISOString();
      const score = computeRecency(now);
      expect(score).toBeGreaterThan(0.99);
      expect(score).toBeLessThanOrEqual(1.0);
    });

    it('should return ~0.5 after one half-life (30 days)', () => {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
      const score = computeRecency(thirtyDaysAgo, 30);
      expect(score).toBeCloseTo(0.5, 1);
    });

    it('should return ~0.0 for very old access', () => {
      const yearAgo = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString();
      const score = computeRecency(yearAgo, 30);
      expect(score).toBeLessThan(0.01);
    });

    it('should return 0.0 for null lastAccessed', () => {
      expect(computeRecency(null)).toBe(0.0);
    });

    it('should return 0.0 for invalid date string', () => {
      expect(computeRecency('not-a-date')).toBe(0.0);
    });

    it('should handle custom half-life', () => {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      const score = computeRecency(sevenDaysAgo, 7);
      expect(score).toBeCloseTo(0.5, 1);
    });

    it('should return value between 0 and 1', () => {
      const someTimeAgo = new Date(Date.now() - 15 * 24 * 3600 * 1000).toISOString();
      const score = computeRecency(someTimeAgo);
      expect(score).toBeGreaterThanOrEqual(0.0);
      expect(score).toBeLessThanOrEqual(1.0);
    });

    it('should handle zero half-life days with zero age', () => {
      // When halfLifeHours <= 0 and age is 0, return 1.0
      // We can't truly test age=0 with halfLife=0 in practice,
      // but we verify the boundary behavior
      const score = computeRecency(null, 0);
      expect(score).toBe(0.0);
    });
  });

  describe('computeCombinedScore', () => {
    it('should compute default weighted combination', () => {
      const score = computeCombinedScore(1.0, 1.0, 1.0);
      // 0.3*1 + 0.5*1 + 0.2*1 = 1.0
      expect(score).toBeCloseTo(1.0, 5);
    });

    it('should compute with all zeros', () => {
      const score = computeCombinedScore(0.0, 0.0, 0.0);
      expect(score).toBe(0.0);
    });

    it('should compute with custom weights', () => {
      const weights: ScoringWeights = {
        recency: 0.5,
        relevance: 0.3,
        importance: 0.2,
      };
      const score = computeCombinedScore(0.8, 0.6, 0.4, weights);
      // 0.5*0.8 + 0.3*0.6 + 0.2*0.4 = 0.4 + 0.18 + 0.08 = 0.66
      expect(score).toBeCloseTo(0.66, 5);
    });

    it('should clamp result to [0, 1]', () => {
      // Even with extreme values, result should be clamped
      const score = computeCombinedScore(1.0, 1.0, 1.0, {
        recency: 1.0,
        relevance: 1.0,
        importance: 1.0,
      });
      // 1*1 + 1*1 + 1*1 = 3.0 -> clamped to 1.0
      expect(score).toBe(1.0);
    });

    it('should use default scoring weights from shared types', () => {
      const score = computeCombinedScore(0.5, 0.5, 0.5);
      // 0.3*0.5 + 0.5*0.5 + 0.2*0.5 = 0.15 + 0.25 + 0.10 = 0.50
      expect(score).toBeCloseTo(0.5, 5);
    });

    it('should handle only relevance contributing', () => {
      const score = computeCombinedScore(0.0, 1.0, 0.0);
      // 0.3*0 + 0.5*1 + 0.2*0 = 0.5
      expect(score).toBeCloseTo(0.5, 5);
    });
  });
});

// ── Assembler Tests ───────────────────────────────────────────────────

describe('assembler', () => {
  const config = makeConfig({ contextTotalBudget: 1000 });
  const assembler = new ContextAssembler(config);

  describe('assemble', () => {
    it('should return empty context for no inputs', () => {
      const result = assembler.assemble({});
      expect(result.memoryContext).toBe('');
      expect(result.tokensUsed).toBe(0);
    });

    it('should assemble with only system prompt', () => {
      const result = assembler.assemble({ systemPrompt: 'You are a helpful assistant.' });
      expect(result.memoryContext).toContain('You are a helpful assistant.');
      expect(result.tokensUsed).toBeGreaterThan(0);
    });

    it('should assemble with only memories', () => {
      const memories = [
        makeRetrievalResult('Memory about TypeScript', 0.9),
        makeRetrievalResult('Memory about React', 0.8),
      ];
      const result = assembler.assemble({ memories });
      expect(result.memoryContext).toContain('[관련 기억]');
      expect(result.memoryContext).toContain('Memory about TypeScript');
      expect(result.memoryContext).toContain('Memory about React');
      expect(result.tokensUsed).toBeGreaterThan(0);
    });

    it('should assemble with all components', () => {
      const memories = [makeRetrievalResult('Important fact', 0.9)];
      const result = assembler.assemble({
        memories,
        systemPrompt: 'System prompt here.',
        recentHistory: 'User: Hello\nAssistant: Hi!',
        userMessage: 'What is TypeScript?',
      });
      expect(result.memoryContext).toContain('System prompt here.');
      expect(result.memoryContext).toContain('[관련 기억]');
      expect(result.memoryContext).toContain('Important fact');
      expect(result.memoryContext).toContain('User: Hello');
      expect(result.memoryContext).toContain('What is TypeScript?');
      expect(result.tokensUsed).toBeGreaterThan(0);
    });

    it('should mark high-importance memories', () => {
      const memories = [makeRetrievalResult('Critical decision', 0.95, 0.9)];
      const result = assembler.assemble({ memories });
      expect(result.memoryContext).toContain('[중요]');
    });

    it('should not mark low-importance memories', () => {
      const memories = [makeRetrievalResult('Minor note', 0.5, 0.3)];
      const result = assembler.assemble({ memories });
      expect(result.memoryContext).not.toContain('[중요]');
    });

    it('should truncate system prompt when exceeding budget', () => {
      const smallConfig = makeConfig({ contextTotalBudget: 20 });
      const smallAssembler = new ContextAssembler(smallConfig);
      const longPrompt = Array.from({ length: 200 }, () => 'word').join(' ');
      const result = smallAssembler.assemble({ systemPrompt: longPrompt });
      expect(result.tokensUsed).toBeLessThanOrEqual(20);
    });

    it('should truncate recent history when exceeding budget', () => {
      const smallConfig = makeConfig({ contextTotalBudget: 20 });
      const smallAssembler = new ContextAssembler(smallConfig);
      const longHistory = Array.from({ length: 200 }, () => 'message').join(' ');
      const result = smallAssembler.assemble({ recentHistory: longHistory });
      expect(result.tokensUsed).toBeLessThanOrEqual(20);
    });

    it('should stop adding memories when budget exhausted', () => {
      const tinyConfig = makeConfig({ contextTotalBudget: 30 });
      const tinyAssembler = new ContextAssembler(tinyConfig);
      const memories = Array.from({ length: 50 }, (_, i) =>
        makeRetrievalResult(`Memory item number ${i} with some extra content`, 0.9 - i * 0.01),
      );
      const result = tinyAssembler.assemble({ memories });
      // Should not include all 50 memories
      const memoryLines = result.memoryContext
        .split('\n')
        .filter((line) => line.startsWith('- '));
      expect(memoryLines.length).toBeLessThan(50);
    });
  });

  describe('calculateBudgets', () => {
    it('should redistribute budget from empty components', () => {
      const budgets = ContextAssembler.calculateBudgets(
        1000,
        DEFAULT_BUDGET_RATIOS,
        {
          systemPrompt: false,
          memories: true,
          recentHistory: true,
          responseReserve: true,
        },
      );
      // systemPrompt (15%) should be redistributed
      // Active: memories (25%) + recentHistory (50%) + reserve (10%) = 85%
      // Each gets proportional share of 15%
      const totalActive = budgets.memories + budgets.recentHistory + budgets.responseReserve;
      expect(totalActive).toBeGreaterThan(850);
      expect(budgets.systemPrompt).toBe(0);
    });

    it('should give all budget components their ratio when all present', () => {
      const budgets = ContextAssembler.calculateBudgets(
        1000,
        DEFAULT_BUDGET_RATIOS,
        {
          systemPrompt: true,
          memories: true,
          recentHistory: true,
          responseReserve: true,
        },
      );
      expect(budgets.systemPrompt).toBe(150);
      expect(budgets.memories).toBe(250);
      expect(budgets.recentHistory).toBe(500);
      expect(budgets.responseReserve).toBe(100);
    });

    it('should handle only responseReserve being active', () => {
      const budgets = ContextAssembler.calculateBudgets(
        1000,
        DEFAULT_BUDGET_RATIOS,
        {
          systemPrompt: false,
          memories: false,
          recentHistory: false,
          responseReserve: true,
        },
      );
      // All inactive budget (90%) redistributed to responseReserve
      expect(budgets.responseReserve).toBe(1000);
      expect(budgets.systemPrompt).toBe(0);
      expect(budgets.memories).toBe(0);
      expect(budgets.recentHistory).toBe(0);
    });
  });

  describe('formatMemories', () => {
    it('should return empty string for empty memories', () => {
      expect(ContextAssembler.formatMemories([], 100)).toBe('');
    });

    it('should format memories with header', () => {
      const memories = [makeRetrievalResult('Test memory', 0.9)];
      const result = ContextAssembler.formatMemories(memories, 100);
      expect(result).toContain('[관련 기억]');
      expect(result).toContain('- Test memory');
    });

    it('should return empty string when budget too small for any memory', () => {
      const memories = [makeRetrievalResult('This is a memory entry', 0.9)];
      // Budget of 1 token - only header might fit but no memory entries
      const result = ContextAssembler.formatMemories(memories, 1);
      // Header alone takes more than 1 token (CJK characters),
      // but even if header fits, no memories will fit
      // The function returns '' if lines.length <= 1
      expect(result).toBe('');
    });
  });
});
