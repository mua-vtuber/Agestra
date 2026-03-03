import { describe, it, expect, vi } from 'vitest';
import { LlmStrategy } from '../llm-strategy.js';
import type { ExtractionLlmFn } from '../llm-strategy.js';
import type { AnnotatedMessage } from '../pipeline.js';

function createMockLlm(response: string): ExtractionLlmFn {
  return vi.fn<ExtractionLlmFn>().mockResolvedValue(response);
}

const sampleMessages: AnnotatedMessage[] = [
  { content: 'React를 사용하기로 결정했습니다.', providerId: 'ai-1' },
  { content: 'TypeScript가 좋을 것 같아요.', providerId: 'ai-2' },
];

describe('LlmStrategy.extract', () => {
  it('calls LLM and parses valid response', async () => {
    const response = JSON.stringify([
      {
        content: 'React를 프론트엔드 프레임워크로 선택',
        nodeType: 'decision',
        topic: 'technical',
        importance: 0.8,
        providerId: 'ai-1',
        confidence: 0.9,
      },
    ]);

    const llmFn = createMockLlm(response);
    const strategy = new LlmStrategy(llmFn);
    const items = await strategy.extract(sampleMessages);

    expect(items).toHaveLength(1);
    expect(items[0].content).toBe('React를 프론트엔드 프레임워크로 선택');
    expect(items[0].nodeType).toBe('decision');
    expect(items[0].providerId).toBe('ai-1');
    expect(items[0].confidence).toBe(0.9);
    expect(llmFn).toHaveBeenCalledOnce();
  });

  it('returns empty array for empty messages', async () => {
    const llmFn = createMockLlm('[]');
    const strategy = new LlmStrategy(llmFn);
    const items = await strategy.extract([]);

    expect(items).toEqual([]);
    expect(llmFn).not.toHaveBeenCalled();
  });

  it('handles LLM failure gracefully', async () => {
    const llmFn = vi.fn<ExtractionLlmFn>().mockRejectedValue(new Error('API error'));
    const strategy = new LlmStrategy(llmFn);
    const items = await strategy.extract(sampleMessages);

    expect(items).toEqual([]);
  });

  it('includes provider IDs in prompt', async () => {
    const llmFn = createMockLlm('[]');
    const strategy = new LlmStrategy(llmFn);
    await strategy.extract(sampleMessages);

    const userPrompt = (llmFn as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(userPrompt).toContain('[ai-1]');
    expect(userPrompt).toContain('[ai-2]');
  });
});

describe('LlmStrategy.parseResponse', () => {
  it('parses valid JSON array', () => {
    const json = JSON.stringify([
      { content: 'Test fact', nodeType: 'fact', topic: 'technical', importance: 0.6 },
    ]);

    const items = LlmStrategy.parseResponse(json);
    expect(items).toHaveLength(1);
    expect(items[0].content).toBe('Test fact');
    expect(items[0].nodeType).toBe('fact');
  });

  it('handles markdown code fences', () => {
    const raw = '```json\n[{"content": "Fenced item", "nodeType": "decision"}]\n```';
    const items = LlmStrategy.parseResponse(raw);
    expect(items).toHaveLength(1);
    expect(items[0].content).toBe('Fenced item');
  });

  it('handles plain code fences', () => {
    const raw = '```\n[{"content": "Plain fence"}]\n```';
    const items = LlmStrategy.parseResponse(raw);
    expect(items).toHaveLength(1);
  });

  it('returns empty for invalid JSON', () => {
    expect(LlmStrategy.parseResponse('not json')).toEqual([]);
  });

  it('returns empty for non-array JSON', () => {
    expect(LlmStrategy.parseResponse('{"content": "not array"}')).toEqual([]);
  });

  it('returns empty for empty string', () => {
    expect(LlmStrategy.parseResponse('')).toEqual([]);
  });

  it('defaults nodeType to fact when invalid', () => {
    const json = JSON.stringify([{ content: 'Test', nodeType: 'invalid_type' }]);
    const items = LlmStrategy.parseResponse(json);
    expect(items[0].nodeType).toBe('fact');
  });

  it('defaults topic to technical when invalid', () => {
    const json = JSON.stringify([{ content: 'Test', topic: 'invalid_topic' }]);
    const items = LlmStrategy.parseResponse(json);
    expect(items[0].topic).toBe('technical');
  });

  it('clamps importance to [0, 1]', () => {
    const json = JSON.stringify([
      { content: 'Low', importance: -0.5 },
      { content: 'High', importance: 1.5 },
    ]);

    const items = LlmStrategy.parseResponse(json);
    expect(items[0].importance).toBe(0);
    expect(items[1].importance).toBe(1);
  });

  it('defaults confidence to 0.7 when missing', () => {
    const json = JSON.stringify([{ content: 'No confidence field' }]);
    const items = LlmStrategy.parseResponse(json);
    expect(items[0].confidence).toBe(0.7);
  });

  it('skips items with empty content', () => {
    const json = JSON.stringify([
      { content: '' },
      { content: '   ' },
      { content: 'Valid item' },
    ]);

    const items = LlmStrategy.parseResponse(json);
    expect(items).toHaveLength(1);
    expect(items[0].content).toBe('Valid item');
  });

  it('deduplicates items by content', () => {
    const json = JSON.stringify([
      { content: 'Same content', importance: 0.8 },
      { content: 'Same content', importance: 0.6 },
    ]);

    const items = LlmStrategy.parseResponse(json);
    expect(items).toHaveLength(1);
  });

  it('skips non-object array items', () => {
    const json = JSON.stringify(['string', 42, null, { content: 'Valid' }]);
    const items = LlmStrategy.parseResponse(json);
    expect(items).toHaveLength(1);
    expect(items[0].content).toBe('Valid');
  });
});
