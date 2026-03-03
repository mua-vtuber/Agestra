/**
 * Generic pipeline engine for the memory system.
 *
 * Provides a type-safe, composable stage chain for both storage
 * and retrieval pipelines. Each stage transforms an input into
 * an output, and stages are connected in sequence.
 *
 * A stage may return `null` to short-circuit the pipeline
 * (e.g., RetrievalGate deciding no search is needed).
 */

import { getMemoryEventBus } from './event-bus.js';

// ── Interfaces ───────────────────────────────────────────────────────

/** A single processing step in a pipeline. */
export interface PipelineStage<TIn, TOut> {
  /** Human-readable name for logging/debugging. */
  readonly name: string;
  /** Process input and return output, or null to stop the pipeline. */
  execute(input: TIn): Promise<TOut | null>;
}

/** Result of a pipeline execution. */
export interface PipelineResult<T> {
  /** The final output (null if short-circuited). */
  output: T | null;
  /** Which stage short-circuited, if any. */
  stoppedAt?: string;
  /** Execution time per stage in ms. */
  timings: Array<{ stage: string; ms: number }>;
}

// ── Annotated Message ────────────────────────────────────────────────

/** A conversation message with provider attribution. */
export interface AnnotatedMessage {
  content: string;
  providerId: string;
  messageId?: string;
  conversationId?: string;
}

// ── Pipeline Builder ─────────────────────────────────────────────────

/**
 * Type-safe pipeline builder that chains stages sequentially.
 *
 * Usage:
 * ```ts
 * const result = await Pipeline
 *   .create<Input>('my-pipeline')
 *   .addStage(stageA)
 *   .addStage(stageB)
 *   .execute(input);
 * ```
 */
export class Pipeline<TIn, TCurrent> {
  private readonly pipelineName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly stages: PipelineStage<any, any>[];

  private constructor(
    pipelineName: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stages: PipelineStage<any, any>[],
  ) {
    this.pipelineName = pipelineName;
    this.stages = stages;
  }

  /** Create a new pipeline with the given name and input type. */
  static create<T>(name: string): Pipeline<T, T> {
    return new Pipeline<T, T>(name, []);
  }

  /** Append a stage to the pipeline, producing a new output type. */
  addStage<TNext>(stage: PipelineStage<TCurrent, TNext>): Pipeline<TIn, TNext> {
    return new Pipeline<TIn, TNext>(this.pipelineName, [...this.stages, stage]);
  }

  /** Execute the full pipeline from input to final output. */
  async execute(input: TIn): Promise<PipelineResult<TCurrent>> {
    const timings: Array<{ stage: string; ms: number }> = [];
    let current: unknown = input;

    for (const stage of this.stages) {
      const start = performance.now();
      try {
        const result = await stage.execute(current);
        const elapsed = performance.now() - start;
        timings.push({ stage: stage.name, ms: Math.round(elapsed * 100) / 100 });

        if (result === null) {
          return { output: null, stoppedAt: stage.name, timings };
        }
        current = result;
      } catch (err: unknown) {
        const elapsed = performance.now() - start;
        timings.push({ stage: stage.name, ms: Math.round(elapsed * 100) / 100 });

        getMemoryEventBus().emitError(
          'extraction_failed',
          `Pipeline "${this.pipelineName}" failed at stage "${stage.name}"`,
          { error: err instanceof Error ? err : new Error(String(err)) },
        );

        return { output: null, stoppedAt: stage.name, timings };
      }
    }

    return { output: current as TCurrent, timings };
  }
}
