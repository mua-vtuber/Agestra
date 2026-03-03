/**
 * LLM-powered extraction strategy (Phase 3-b).
 *
 * Uses a language model to extract structured knowledge items from
 * conversation messages. Produces higher-quality extractions than
 * regex, including refined content and confidence scores.
 *
 * Falls back gracefully: if the LLM call fails, returns empty array
 * rather than throwing (the pipeline will short-circuit).
 */

import type { ExtractionItem, NodeType, MemoryTopic } from './types.js';
import type { ExtractionStrategy } from './extraction-strategy.js';
import type { AnnotatedMessage } from './pipeline.js';
import { getMemoryEventBus } from './event-bus.js';

// -- Types ------------------------------------------------------------------

/** LLM function: system prompt + user prompt -> text response. */
export type ExtractionLlmFn = (
  systemPrompt: string,
  userPrompt: string,
) => Promise<string>;

/** Raw item from LLM JSON output. */
interface LlmExtractionRaw {
  content?: string;
  nodeType?: string;
  topic?: string;
  importance?: number;
  providerId?: string;
  confidence?: number;
}

// -- System Prompt ----------------------------------------------------------

const EXTRACTION_SYSTEM_PROMPT = `You are a knowledge extraction assistant. Extract structured facts, decisions, preferences, and technical information from the given conversation.

For each extracted item, return:
- "content": A refined, concise statement (not verbatim quotes). Translate colloquial phrasing into clear, factual statements.
- "nodeType": One of "fact", "decision", "preference", "insight"
- "topic": One of "technical", "decisions", "preferences", "context"
- "importance": A number from 0.0 to 1.0 (decisions are typically 0.7+, preferences 0.5+, facts 0.5+)
- "providerId": The speaker ID who stated this (from the message tags)
- "confidence": Your confidence in the extraction accuracy, 0.0 to 1.0

Rules:
1. Refine colloquial statements into clear factual statements
2. Preserve the original language (Korean or English)
3. Do NOT extract greetings, filler words, or meta-conversation
4. Merge overlapping/repeated statements into a single item
5. Return ONLY a JSON array. No markdown, no explanation.
6. If nothing worth extracting, return: []`;

// -- Validation -------------------------------------------------------------

const VALID_NODE_TYPES = new Set<string>(['fact', 'decision', 'preference', 'insight']);
const VALID_TOPICS = new Set<string>(['technical', 'decisions', 'preferences', 'context']);

function isValidNodeType(s: string): s is NodeType {
  return VALID_NODE_TYPES.has(s);
}

function isValidTopic(s: string): s is MemoryTopic {
  return VALID_TOPICS.has(s);
}

// -- LlmStrategy ------------------------------------------------------------

/**
 * LLM-powered extraction that produces refined, high-confidence items.
 *
 * When configured (via extractionLlmProviderId), this replaces
 * RegexStrategy entirely -- regex is a subset of LLM capability.
 */
export class LlmStrategy implements ExtractionStrategy {
  readonly name = 'LlmStrategy';
  private readonly llmFn: ExtractionLlmFn;

  constructor(llmFn: ExtractionLlmFn) {
    this.llmFn = llmFn;
  }

  async extract(messages: AnnotatedMessage[]): Promise<ExtractionItem[]> {
    if (messages.length === 0) {
      return [];
    }

    const userPrompt = this.buildUserPrompt(messages);

    let rawResponse: string;
    try {
      rawResponse = await this.llmFn(EXTRACTION_SYSTEM_PROMPT, userPrompt);
    } catch (err: unknown) {
      getMemoryEventBus().emitError('extraction_failed', 'LLM extraction call failed', {
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return [];
    }

    return LlmStrategy.parseResponse(rawResponse);
  }

  /** Build user prompt with annotated messages. */
  private buildUserPrompt(messages: AnnotatedMessage[]): string {
    const lines = messages.map(
      (msg) => `[${msg.providerId}]: ${msg.content}`,
    );
    return `Extract knowledge from the following conversation:\n\n${lines.join('\n')}`;
  }

  /**
   * Parse LLM response into validated ExtractionItems.
   *
   * Handles markdown fences, invalid JSON, and malformed items
   * gracefully -- returns whatever valid items can be recovered.
   */
  static parseResponse(raw: string): ExtractionItem[] {
    if (!raw || raw.trim().length === 0) {
      return [];
    }

    // Strip markdown code fences
    let cleaned = raw.trim();
    const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) {
      cleaned = fenceMatch[1].trim();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return [];
    }

    if (!Array.isArray(parsed)) {
      return [];
    }

    const items: ExtractionItem[] = [];
    const seen = new Set<string>();

    for (const raw of parsed) {
      if (!raw || typeof raw !== 'object') continue;

      const item = raw as LlmExtractionRaw;
      if (!item.content || typeof item.content !== 'string' || item.content.trim().length === 0) {
        continue;
      }

      const content = item.content.trim();
      if (seen.has(content)) continue;
      seen.add(content);

      const nodeType = (typeof item.nodeType === 'string' && isValidNodeType(item.nodeType))
        ? item.nodeType
        : 'fact';

      const topic = (typeof item.topic === 'string' && isValidTopic(item.topic))
        ? item.topic
        : 'technical';

      const importance = typeof item.importance === 'number'
        ? Math.max(0.0, Math.min(1.0, item.importance))
        : 0.5;

      const confidence = typeof item.confidence === 'number'
        ? Math.max(0.0, Math.min(1.0, item.confidence))
        : 0.7; // LLM extraction defaults to higher confidence than regex

      const providerId = typeof item.providerId === 'string'
        ? item.providerId
        : undefined;

      items.push({
        content,
        nodeType,
        topic,
        importance,
        providerId,
        confidence,
      });
    }

    return items;
  }
}
