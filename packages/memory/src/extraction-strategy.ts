/**
 * Extraction strategy interface and RegexStrategy implementation.
 *
 * Defines the contract for extracting knowledge items from conversation
 * messages. Two implementations exist:
 * - RegexStrategy: Pattern-based extraction (Phase 3-a, no LLM)
 * - LlmStrategy: LLM-powered structured extraction (Phase 3-b)
 *
 * The facade selects the strategy based on config.extractionLlmProviderId.
 */

import type { ExtractionItem, MemoryConfig } from './types.js';
import { DEFAULT_MEMORY_CONFIG } from './types.js';
import { RegexExtractor } from './extractor.js';
import type { AnnotatedMessage } from './pipeline.js';
import type { PipelineStage } from './pipeline.js';

// -- Strategy Interface --

/** Strategy for extracting knowledge items from messages. */
export interface ExtractionStrategy {
  /** Human-readable name for logging. */
  readonly name: string;
  /** Extract structured items from annotated messages. */
  extract(messages: AnnotatedMessage[]): Promise<ExtractionItem[]>;
}

// -- RegexStrategy --

/**
 * Regex-based extraction strategy (Phase 3-a).
 *
 * Wraps the existing RegexExtractor and decorates results with
 * providerId from the source messages. No LLM dependency.
 */
export class RegexStrategy implements ExtractionStrategy {
  readonly name = 'RegexStrategy';
  private readonly extractor: RegexExtractor;

  constructor(config?: Partial<MemoryConfig>) {
    this.extractor = new RegexExtractor(config);
  }

  async extract(messages: AnnotatedMessage[]): Promise<ExtractionItem[]> {
    const items: ExtractionItem[] = [];
    const seen = new Set<string>();

    for (const msg of messages) {
      const extracted = this.extractor.extract(msg.content);
      for (const item of extracted) {
        if (!seen.has(item.content)) {
          seen.add(item.content);
          items.push({
            ...item,
            providerId: msg.providerId,
            confidence: 0.5, // Regex extraction = moderate confidence
          });
        }
      }
    }

    return items;
  }
}

// -- ExtractionStage (Pipeline adapter) --

/** Input to the extraction pipeline stage. */
export interface ExtractionStageInput {
  messages: AnnotatedMessage[];
  conversationId?: string;
}

/** Output from the extraction pipeline stage. */
export interface ExtractionStageOutput {
  items: ExtractionItem[];
  messages: AnnotatedMessage[];
  conversationId?: string;
}

/**
 * Pipeline stage that runs extraction via the configured strategy.
 */
export class ExtractionStage implements PipelineStage<ExtractionStageInput, ExtractionStageOutput> {
  readonly name = 'ExtractionStage';
  private readonly strategy: ExtractionStrategy;
  private readonly minImportance: number;

  constructor(strategy: ExtractionStrategy, config?: Partial<MemoryConfig>) {
    this.strategy = strategy;
    this.minImportance = config?.extractionMinImportance ?? DEFAULT_MEMORY_CONFIG.extractionMinImportance;
  }

  async execute(input: ExtractionStageInput): Promise<ExtractionStageOutput | null> {
    const items = await this.strategy.extract(input.messages);

    // Filter by minimum importance threshold
    const filtered = items.filter((item) => item.importance >= this.minImportance);

    if (filtered.length === 0) {
      return null; // Short-circuit: nothing worth storing
    }

    return {
      items: filtered,
      messages: input.messages,
      conversationId: input.conversationId,
    };
  }
}
