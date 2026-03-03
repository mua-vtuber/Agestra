import { describe, it, expect } from 'vitest';
import { Pipeline } from '../pipeline.js';
import type { PipelineStage } from '../pipeline.js';

/** Create a simple stage that transforms a number. */
function numberStage(
  name: string,
  fn: (n: number) => number | null,
): PipelineStage<number, number> {
  return {
    name,
    execute: async (input) => fn(input),
  };
}

describe('Pipeline', () => {
  it('executes a single stage', async () => {
    const result = await Pipeline
      .create<number>('test')
      .addStage(numberStage('double', (n) => n * 2))
      .execute(5);

    expect(result.output).toBe(10);
    expect(result.stoppedAt).toBeUndefined();
    expect(result.timings).toHaveLength(1);
    expect(result.timings[0].stage).toBe('double');
  });

  it('chains multiple stages', async () => {
    const result = await Pipeline
      .create<number>('test')
      .addStage(numberStage('add1', (n) => n + 1))
      .addStage(numberStage('double', (n) => n * 2))
      .addStage(numberStage('sub3', (n) => n - 3))
      .execute(5);

    // (5 + 1) * 2 - 3 = 9
    expect(result.output).toBe(9);
    expect(result.timings).toHaveLength(3);
  });

  it('short-circuits on null', async () => {
    const result = await Pipeline
      .create<number>('test')
      .addStage(numberStage('add1', (n) => n + 1))
      .addStage(numberStage('gate', () => null))
      .addStage(numberStage('should-not-run', (n) => n * 100))
      .execute(5);

    expect(result.output).toBeNull();
    expect(result.stoppedAt).toBe('gate');
    expect(result.timings).toHaveLength(2);
  });

  it('handles stage errors gracefully', async () => {
    const errorStage: PipelineStage<number, number> = {
      name: 'error-stage',
      execute: async () => { throw new Error('boom'); },
    };

    const result = await Pipeline
      .create<number>('test')
      .addStage(numberStage('add1', (n) => n + 1))
      .addStage(errorStage)
      .addStage(numberStage('should-not-run', (n) => n * 2))
      .execute(5);

    expect(result.output).toBeNull();
    expect(result.stoppedAt).toBe('error-stage');
    expect(result.timings).toHaveLength(2);
  });

  it('records timing for each stage', async () => {
    const result = await Pipeline
      .create<number>('timing-test')
      .addStage(numberStage('fast', (n) => n))
      .addStage(numberStage('also-fast', (n) => n))
      .execute(1);

    expect(result.timings).toHaveLength(2);
    for (const t of result.timings) {
      expect(typeof t.ms).toBe('number');
      expect(t.ms).toBeGreaterThanOrEqual(0);
    }
  });

  it('works with type transformations between stages', async () => {
    const toString: PipelineStage<number, string> = {
      name: 'to-string',
      execute: async (n) => `value:${n}`,
    };

    const toUpper: PipelineStage<string, string> = {
      name: 'to-upper',
      execute: async (s) => s.toUpperCase(),
    };

    const result = await Pipeline
      .create<number>('type-transform')
      .addStage(toString)
      .addStage(toUpper)
      .execute(42);

    expect(result.output).toBe('VALUE:42');
  });

  it('returns input when no stages added', async () => {
    const result = await Pipeline
      .create<number>('empty')
      .execute(42);

    expect(result.output).toBe(42);
    expect(result.timings).toHaveLength(0);
  });
});
