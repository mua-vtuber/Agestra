/**
 * Stanford Generative Agents inspired 3-factor scoring.
 *
 * Combines recency, relevance, and importance into a single retrieval score.
 * Recency uses exponential decay so memories gradually fade unless accessed.
 *
 * Ported from bara_system/backend/app/services/memory/scoring.py
 */

import type { ScoringWeights } from './types.js';
import { DEFAULT_SCORING_WEIGHTS } from './types.js';

/** Default half-life in days for recency decay. */
const DEFAULT_HALF_LIFE_DAYS = 30;

/**
 * Compute recency score using exponential decay.
 *
 * Score is 1.0 when just accessed, decaying to 0.5 after `halfLifeDays`.
 *
 * @param lastAccessed - ISO timestamp of last access, or null.
 * @param halfLifeDays - Number of days for the score to halve (default 30).
 * @returns Recency score in [0.0, 1.0].
 */
export function computeRecency(
  lastAccessed: string | null,
  halfLifeDays: number = DEFAULT_HALF_LIFE_DAYS,
): number {
  if (lastAccessed === null) {
    return 0.0;
  }

  const now = Date.now();
  let accessedTime: number;

  try {
    accessedTime = new Date(lastAccessed).getTime();
  } catch {
    return 0.0;
  }

  if (isNaN(accessedTime)) {
    return 0.0;
  }

  const ageHours = Math.max(0, (now - accessedTime) / (1000 * 3600));
  const halfLifeHours = halfLifeDays * 24;

  if (halfLifeHours <= 0) {
    return ageHours === 0 ? 1.0 : 0.0;
  }

  // Exponential decay: score = 2^(-age/half_life)
  const decay = Math.pow(2, -ageHours / halfLifeHours);
  return Math.max(0.0, Math.min(1.0, decay));
}

/**
 * Compute weighted combination of the three scoring factors.
 *
 * @param recency - Recency score [0, 1].
 * @param relevance - Relevance score [0, 1] (e.g. cosine similarity or FTS rank).
 * @param importance - Importance score [0, 1].
 * @param weights - Optional scoring weights (defaults to Stanford Generative Agents weights).
 * @returns Combined score in [0.0, 1.0].
 */
export function computeCombinedScore(
  recency: number,
  relevance: number,
  importance: number,
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS,
): number {
  const score =
    weights.recency * recency +
    weights.relevance * relevance +
    weights.importance * importance;
  return Math.max(0.0, Math.min(1.0, score));
}
