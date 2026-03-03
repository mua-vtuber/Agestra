/**
 * Gemini CLI output parser.
 *
 * The Gemini CLI outputs noise lines mixed with actual responses.
 * This module filters out known noise patterns and extracts clean text.
 */

const NOISE_PATTERNS = [
  /^Loaded cached credentials/i,
  /^\[debug\]/i,
  /^\[info\]/i,
  /^\[warn\]/i,
  /^Using /i,
  /^Model:/i,
];

/**
 * Filter noise lines from Gemini CLI output, returning only meaningful content.
 */
export function filterGeminiOutput(output: string): string {
  const lines = output.split("\n");
  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    return !NOISE_PATTERNS.some((p) => p.test(trimmed));
  });
  return filtered.join("\n").trim();
}

/**
 * Parse Gemini CLI `-o json` output.
 * The output is a single JSON object with a "response" field.
 *
 * @returns The response string if found, null otherwise.
 */
export function parseGeminiJsonOutput(output: string): string | null {
  try {
    const parsed = JSON.parse(output.trim());
    if (parsed && typeof parsed.response === "string") {
      return parsed.response;
    }
  } catch {
    /* not JSON — try line-by-line as fallback */
    const lines = output.split("\n");
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line.trim());
        if (parsed && typeof parsed.response === "string") {
          return parsed.response;
        }
      } catch {
        /* skip */
      }
    }
  }
  return null;
}
