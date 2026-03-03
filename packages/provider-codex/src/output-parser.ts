/**
 * Codex CLI output parser.
 *
 * Codex `exec --json` outputs JSONL events. Agent messages appear as:
 *   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
 *
 * We extract agent_message text from item.completed events.
 */

export interface CodexEvent {
  type: string;
  item?: {
    type: string;
    text?: string;
  };
  [key: string]: unknown;
}

/**
 * Parse Codex CLI JSONL output and extract agent message text.
 * Falls back to plain text if lines are not valid JSON.
 */
export function parseCodexOutput(output: string): string {
  const lines = output.trim().split("\n");
  const results: string[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as CodexEvent;
      if (
        parsed.type === "item.completed" &&
        parsed.item?.type === "agent_message" &&
        parsed.item.text
      ) {
        results.push(parsed.item.text);
      }
    } catch {
      // Not JSON -- might be plain text output
      if (line.trim()) results.push(line.trim());
    }
  }

  return results.join("\n") || output.trim();
}
