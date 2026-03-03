import { describe, it, expect } from 'vitest';
import { RetrievalGate } from '../retrieval-gate.js';
import type { RetrievalPipelineData } from '../types.js';

// ── Helpers ─────────────────────────────────────────────────────────

function makeInput(
  query: string,
  results: RetrievalPipelineData['results'] = [],
): RetrievalPipelineData {
  return { query, results };
}

// ── RetrievalGate ───────────────────────────────────────────────────

describe('RetrievalGate', () => {
  const gate = new RetrievalGate();

  it('passes through normal queries', async () => {
    const input = makeInput('React framework decision');
    const result = await gate.execute(input);
    expect(result).not.toBeNull();
    expect(result!.query).toBe('React framework decision');
  });

  it('blocks empty queries', async () => {
    expect(await gate.execute(makeInput(''))).toBeNull();
    expect(await gate.execute(makeInput('   '))).toBeNull();
  });

  it('blocks single-word queries', async () => {
    expect(await gate.execute(makeInput('hello'))).toBeNull();
    expect(await gate.execute(makeInput('React'))).toBeNull();
  });

  it('blocks Korean greetings', async () => {
    expect(await gate.execute(makeInput('안녕'))).toBeNull();
    expect(await gate.execute(makeInput('안녕!'))).toBeNull();
  });

  it('blocks English greetings', async () => {
    expect(await gate.execute(makeInput('hello!'))).toBeNull();
    expect(await gate.execute(makeInput('hi'))).toBeNull();
    expect(await gate.execute(makeInput('hey'))).toBeNull();
    expect(await gate.execute(makeInput('good morning'))).toBeNull();
  });

  it('blocks short affirmations', async () => {
    expect(await gate.execute(makeInput('네'))).toBeNull();
    expect(await gate.execute(makeInput('ok'))).toBeNull();
    expect(await gate.execute(makeInput('thanks'))).toBeNull();
    expect(await gate.execute(makeInput('ㅋㅋㅋ'))).toBeNull();
  });

  it('blocks slash commands', async () => {
    expect(await gate.execute(makeInput('/help'))).toBeNull();
    expect(await gate.execute(makeInput('/reset'))).toBeNull();
  });

  it('passes through multi-word queries', async () => {
    const result = await gate.execute(makeInput('which framework should we use'));
    expect(result).not.toBeNull();
  });

  it('passes through technical questions', async () => {
    const result = await gate.execute(makeInput('how to use generics in TypeScript'));
    expect(result).not.toBeNull();
  });

  it('passes through Korean multi-word queries', async () => {
    const result = await gate.execute(makeInput('어떤 프레임워크를 사용할까'));
    expect(result).not.toBeNull();
  });

  it('blocks "good afternoon" greeting', async () => {
    expect(await gate.execute(makeInput('good afternoon'))).toBeNull();
  });

  it('blocks "good evening" greeting', async () => {
    expect(await gate.execute(makeInput('good evening'))).toBeNull();
  });

  it('blocks Korean affirmations', async () => {
    expect(await gate.execute(makeInput('예'))).toBeNull();
    expect(await gate.execute(makeInput('응'))).toBeNull();
    expect(await gate.execute(makeInput('ㅇㅇ'))).toBeNull();
  });

  it('blocks English affirmations', async () => {
    expect(await gate.execute(makeInput('yes'))).toBeNull();
    expect(await gate.execute(makeInput('no'))).toBeNull();
    expect(await gate.execute(makeInput('nah'))).toBeNull();
    expect(await gate.execute(makeInput('yep'))).toBeNull();
    expect(await gate.execute(makeInput('nope'))).toBeNull();
    expect(await gate.execute(makeInput('sure'))).toBeNull();
    expect(await gate.execute(makeInput('okay'))).toBeNull();
  });

  it('blocks Korean thank you expressions', async () => {
    expect(await gate.execute(makeInput('고마워'))).toBeNull();
    expect(await gate.execute(makeInput('감사'))).toBeNull();
    expect(await gate.execute(makeInput('ㄱㅅ'))).toBeNull();
  });

  it('blocks Korean laugh/emoji', async () => {
    expect(await gate.execute(makeInput('ㅎㅎ'))).toBeNull();
  });

  it('preserves input data through gate', async () => {
    const input: RetrievalPipelineData = {
      query: 'React framework architecture',
      topic: 'technical',
      limit: 5,
      results: [],
    };

    const result = await gate.execute(input);
    expect(result).not.toBeNull();
    expect(result!.query).toBe('React framework architecture');
    expect(result!.topic).toBe('technical');
    expect(result!.limit).toBe(5);
    expect(result!.results).toEqual([]);
  });
});

// ── shouldSkip (public for direct testing) ──────────────────────────

describe('RetrievalGate.shouldSkip', () => {
  const gate = new RetrievalGate();

  it('returns true for empty string', () => {
    expect(gate.shouldSkip('')).toBe(true);
  });

  it('returns true for whitespace', () => {
    expect(gate.shouldSkip('   ')).toBe(true);
    expect(gate.shouldSkip('\t')).toBe(true);
    expect(gate.shouldSkip('\n')).toBe(true);
  });

  it('returns true for single word', () => {
    expect(gate.shouldSkip('hello')).toBe(true);
  });

  it('returns false for multi-word queries', () => {
    expect(gate.shouldSkip('tell me about React')).toBe(false);
  });

  it('returns true for slash commands regardless of length', () => {
    expect(gate.shouldSkip('/help me with something')).toBe(true);
  });
});
