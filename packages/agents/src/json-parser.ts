/**
 * Robust JSON extraction from AI response text.
 *
 * AI providers often wrap JSON in markdown fences, explanatory text,
 * or produce multiple JSON objects. This utility handles all cases
 * by tracking brace depth to find valid JSON candidates.
 */

/**
 * Extract the most relevant JSON object from mixed text.
 *
 * Strategy:
 *   1. Try the full text as JSON.
 *   2. Track brace depth to extract all JSON candidates.
 *   3. Try candidates from last to first (AI responses typically
 *      place the final JSON answer at the end).
 *   4. Return null if no valid JSON is found.
 *
 * @param text - Raw text that may contain JSON.
 * @returns Parsed JSON object, or null.
 */
export function extractJSON(text: string): unknown | null {
  return extractJsonFromText(text);
}

export function extractJsonFromText(text: string): unknown | null {
  if (!text || !text.trim()) return null;

  // 1. Try full text as JSON
  try {
    return JSON.parse(text.trim());
  } catch {
    // continue to extraction
  }

  // 2. Track brace depth to find all JSON candidates
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        candidates.push(text.slice(start, i + 1));
        start = -1;
      }
      // Prevent going negative from stray closing braces
      if (depth < 0) depth = 0;
    }
  }

  if (candidates.length === 0) return null;

  // 3. Try from last to first (AI typically puts the answer last)
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(candidates[i]);
    } catch {
      continue;
    }
  }

  return null;
}
