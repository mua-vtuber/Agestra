/**
 * Token counter with tiktoken (accurate) and CJK-aware heuristic (fallback).
 *
 * Uses js-tiktoken for exact BPE token counting when available.
 * Falls back to heuristic estimation (ported from bara_system) if
 * tiktoken initialization fails or for rapid estimates.
 */

import { encodingForModel, type Tiktoken } from 'js-tiktoken';

// ── Tiktoken Encoder ──────────────────────────────────────────────────

let encoder: Tiktoken | null = null;
let encoderFailed = false;
let currentModel: string = process.env.TIKTOKEN_MODEL ?? 'gpt-4o';

export function setTokenizerModel(model: string): void {
  currentModel = model;
  encoder = null;
  encoderFailed = false;
}

function getEncoder(): Tiktoken | null {
  if (encoder) return encoder;
  if (encoderFailed) return null;

  try {
    encoder = encodingForModel(currentModel as Parameters<typeof encodingForModel>[0]);
    return encoder;
  } catch {
    encoderFailed = true;
    console.warn('[token-counter] tiktoken init failed, using heuristic fallback');
    return null;
  }
}

// ── Heuristic Fallback ────────────────────────────────────────────────

// CJK Unicode ranges (Unified Ideographs + common extensions + Hangul)
const CJK_RE =
  /[\u2e80-\u2eff\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;

/** Average tokens per CJK character (~2 for BPE tokenizers). */
const CJK_TOKENS_PER_CHAR = 2.0;

/** Average tokens per Latin word (~0.75 due to common word merges). */
const LATIN_TOKENS_PER_WORD = 0.75;

function estimateTokensHeuristic(text: string): number {
  if (!text) return 0;
  const cjkMatches = text.match(CJK_RE);
  const cjkChars = cjkMatches ? cjkMatches.length : 0;
  const nonCjk = text.replace(CJK_RE, '');
  const latinWords = nonCjk.split(/\s+/).filter((w) => w.length > 0);
  const tokens = cjkChars * CJK_TOKENS_PER_CHAR + latinWords.length * LATIN_TOKENS_PER_WORD;
  return Math.max(1, Math.round(tokens));
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Count tokens for the given text.
 *
 * Uses tiktoken (exact BPE) when available, otherwise falls back
 * to a CJK-aware heuristic.
 *
 * @param text - Input text (may contain CJK, Latin, or mixed content).
 * @returns Token count (always >= 1 for non-empty text, 0 for empty).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  const enc = getEncoder();
  if (enc) {
    try {
      return enc.encode(text).length;
    } catch {
      // Fall through to heuristic
    }
  }

  return estimateTokensHeuristic(text);
}

/**
 * Truncate text to fit within a token budget.
 *
 * Uses a binary-search approach to find the longest prefix that fits.
 *
 * @param text - Input text.
 * @param budget - Maximum number of tokens allowed.
 * @returns Truncated text (or original if it already fits).
 */
export function truncateToBudget(text: string, budget: number): string {
  if (budget <= 0) return '';
  if (estimateTokens(text) <= budget) return text;

  let low = 0;
  let high = text.length;
  let result = '';

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = text.slice(0, mid);
    if (estimateTokens(candidate) <= budget) {
      result = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return result;
}
