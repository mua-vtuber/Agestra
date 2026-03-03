import { describe, it, expect } from 'vitest';
import { Reranker } from '../reranker.js';
import type { RetrievalPipelineData, KnowledgeNode, RetrievalResult } from '../types.js';

// ── Helpers ─────────────────────────────────────────────────────────

function makeNode(overrides?: Partial<KnowledgeNode>): KnowledgeNode {
  return {
    id: overrides?.id ?? 'test-id',
    content: overrides?.content ?? 'Test content',
    nodeType: overrides?.nodeType ?? 'fact',
    topic: overrides?.topic ?? 'technical',
    importance: overrides?.importance ?? 0.5,
    source: overrides?.source ?? 'auto',
    pinned: overrides?.pinned ?? false,
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
    providerId: overrides?.providerId ?? null,
    lastMentionedAt: overrides?.lastMentionedAt ?? null,
    mentionCount: overrides?.mentionCount ?? 0,
    confidence: overrides?.confidence ?? 0.5,
  };
}

function makeResult(
  overrides?: Partial<RetrievalResult> & { node?: Partial<KnowledgeNode> },
): RetrievalResult {
  return {
    node: makeNode(overrides?.node),
    score: overrides?.score ?? 0.5,
    source: overrides?.source ?? 'fts',
  };
}

function makeInput(
  query: string,
  results: RetrievalResult[] = [],
): RetrievalPipelineData {
  return { query, results };
}

// ── Reranker ────────────────────────────────────────────────────────

describe('Reranker', () => {
  const reranker = new Reranker();

  it('returns empty results unchanged', async () => {
    const input = makeInput('test query', []);
    const result = await reranker.execute(input);
    expect(result.results).toEqual([]);
  });

  it('preserves order when no boosts apply', async () => {
    const input = makeInput('test', [
      makeResult({ score: 0.8, node: { id: 'a' } }),
      makeResult({ score: 0.6, node: { id: 'b' } }),
      makeResult({ score: 0.4, node: { id: 'c' } }),
    ]);

    const result = await reranker.execute(input);
    expect(result.results[0].node.id).toBe('a');
    expect(result.results[1].node.id).toBe('b');
    expect(result.results[2].node.id).toBe('c');
  });

  it('boosts score for nodes with high mention_count', async () => {
    const input = makeInput('test', [
      makeResult({
        score: 0.5,
        node: { id: 'frequently-mentioned', mentionCount: 5 },
      }),
      makeResult({
        score: 0.5,
        node: { id: 'never-mentioned', mentionCount: 0 },
      }),
    ]);

    const result = await reranker.execute(input);

    const mentioned = result.results.find((r) => r.node.id === 'frequently-mentioned');
    const unmentioned = result.results.find((r) => r.node.id === 'never-mentioned');
    expect(mentioned!.score).toBeGreaterThan(unmentioned!.score);
  });

  it('caps mention boost at mentionBoostCap', async () => {
    const input = makeInput('test', [
      makeResult({
        score: 0.5,
        node: { id: 'highly-mentioned', mentionCount: 100 },
      }),
    ]);

    const rerankerWithConfig = new Reranker({
      mentionBoostCap: 0.1,
      mentionBoostPerCount: 0.05,
    });

    const result = await rerankerWithConfig.execute(input);

    // mentionBoost = min(0.1, 0.05 * 100) = 0.1 (capped)
    // score = min(1.0, 0.5 + 0.1) * confidenceFactor
    // With confidence 0.5: factor = 0.8 + 0.2 * 0.5 = 0.9
    // Final = min(1.0, 0.6) * 0.9 = 0.54
    expect(result.results[0].score).toBeCloseTo(0.54, 2);
  });

  it('applies confidence weighting', async () => {
    const input = makeInput('test', [
      makeResult({
        score: 0.5,
        node: { id: 'llm-extracted', confidence: 0.9 },
      }),
      makeResult({
        score: 0.5,
        node: { id: 'regex-extracted', confidence: 0.5 },
      }),
    ]);

    const result = await reranker.execute(input);

    const llm = result.results.find((r) => r.node.id === 'llm-extracted');
    const regex = result.results.find((r) => r.node.id === 'regex-extracted');
    expect(llm!.score).toBeGreaterThan(regex!.score);
  });

  it('enforces limit', async () => {
    const results = Array.from({ length: 20 }, (_, i) =>
      makeResult({ score: 0.5 - i * 0.01, node: { id: `n${i}` } }),
    );
    const input: RetrievalPipelineData = {
      query: 'test',
      limit: 5,
      results,
    };

    const result = await reranker.execute(input);
    expect(result.results).toHaveLength(5);
  });

  it('uses config retrievalLimit as default', async () => {
    const rerankerSmall = new Reranker({ retrievalLimit: 3 });
    const results = Array.from({ length: 10 }, (_, i) =>
      makeResult({ score: 0.5, node: { id: `n${i}` } }),
    );
    const input: RetrievalPipelineData = { query: 'test', results };

    const result = await rerankerSmall.execute(input);
    expect(result.results).toHaveLength(3);
  });

  it('re-sorts by reranked score', async () => {
    const input = makeInput('test', [
      // Lower base score but high mentions → should be boosted
      makeResult({
        score: 0.4,
        node: { id: 'mentioned', mentionCount: 5, confidence: 0.7 },
      }),
      // Higher base score but no mentions
      makeResult({
        score: 0.5,
        node: { id: 'unmentioned', mentionCount: 0, confidence: 0.5 },
      }),
    ]);

    const result = await reranker.execute(input);
    // The mentioned node should be reranked higher due to mention + confidence boost
    expect(result.results[0].node.id).toBe('mentioned');
  });

  it('score never exceeds 1.0', async () => {
    const input = makeInput('test', [
      makeResult({
        score: 0.99,
        node: { id: 'high', mentionCount: 10, confidence: 1.0 },
      }),
    ]);

    const result = await reranker.execute(input);
    expect(result.results[0].score).toBeLessThanOrEqual(1.0);
  });

  it('preserves input metadata', async () => {
    const input: RetrievalPipelineData = {
      query: 'React framework',
      topic: 'technical',
      limit: 5,
      results: [makeResult()],
    };

    const result = await reranker.execute(input);
    expect(result.query).toBe('React framework');
    expect(result.topic).toBe('technical');
    expect(result.limit).toBe(5);
  });
});
