import { describe, it, expect } from 'vitest';
import { RegexStrategy, ExtractionStage } from '../extraction-strategy.js';
import type { AnnotatedMessage } from '../pipeline.js';

describe('RegexStrategy', () => {
  const strategy = new RegexStrategy();

  it('extracts decisions from Korean text', async () => {
    const messages: AnnotatedMessage[] = [
      { content: 'React를 사용하기로 결정했다.', providerId: 'ai-1' },
    ];

    const items = await strategy.extract(messages);
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0].providerId).toBe('ai-1');
    expect(items[0].confidence).toBe(0.5);
  });

  it('preserves provider attribution per message', async () => {
    const messages: AnnotatedMessage[] = [
      { content: 'TypeScript를 쓰기로 했다.', providerId: 'ai-1' },
      { content: 'Python으로 결정했습니다.', providerId: 'ai-2' },
    ];

    const items = await strategy.extract(messages);
    expect(items.length).toBeGreaterThanOrEqual(2);

    const ai1Items = items.filter((i) => i.providerId === 'ai-1');
    const ai2Items = items.filter((i) => i.providerId === 'ai-2');
    expect(ai1Items.length).toBeGreaterThanOrEqual(1);
    expect(ai2Items.length).toBeGreaterThanOrEqual(1);
  });

  it('deduplicates across messages', async () => {
    const messages: AnnotatedMessage[] = [
      { content: 'React를 사용하기로 결정했다.', providerId: 'ai-1' },
      { content: 'React를 사용하기로 결정했다.', providerId: 'ai-2' },
    ];

    const items = await strategy.extract(messages);
    // Should deduplicate even across different providers
    const reactItems = items.filter((i) => i.content.includes('React'));
    expect(reactItems.length).toBe(1);
  });

  it('returns empty for non-matching content', async () => {
    const messages: AnnotatedMessage[] = [
      { content: '안녕하세요. 좋은 하루 되세요.', providerId: 'ai-1' },
    ];

    const items = await strategy.extract(messages);
    expect(items).toEqual([]);
  });
});

describe('ExtractionStage', () => {
  it('filters items below importance threshold', async () => {
    const strategy = new RegexStrategy();
    const stage = new ExtractionStage(strategy, { extractionMinImportance: 0.99 });

    const result = await stage.execute({
      messages: [
        { content: 'React를 추천합니다.', providerId: 'ai-1' },
      ],
    });

    // Should short-circuit since all items are below 0.99
    expect(result).toBeNull();
  });

  it('passes through when items meet threshold', async () => {
    const strategy = new RegexStrategy();
    const stage = new ExtractionStage(strategy, { extractionMinImportance: 0.3 });

    const result = await stage.execute({
      messages: [
        { content: 'React를 사용하기로 결정했다.', providerId: 'ai-1' },
      ],
      conversationId: 'conv-1',
    });

    expect(result).not.toBeNull();
    expect(result!.items.length).toBeGreaterThanOrEqual(1);
    expect(result!.conversationId).toBe('conv-1');
  });

  it('preserves messages and conversationId in output', async () => {
    const strategy = new RegexStrategy();
    const stage = new ExtractionStage(strategy, { extractionMinImportance: 0.1 });

    const messages: AnnotatedMessage[] = [
      { content: 'TypeScript를 쓰기로 했다.', providerId: 'ai-1' },
    ];

    const result = await stage.execute({
      messages,
      conversationId: 'conv-42',
    });

    expect(result).not.toBeNull();
    expect(result!.messages).toBe(messages);
    expect(result!.conversationId).toBe('conv-42');
  });
});
