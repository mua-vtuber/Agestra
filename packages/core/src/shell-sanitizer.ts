/**
 * Shell command sanitization utilities.
 *
 * Provides multi-layered defense against command injection in agent shell_exec:
 *   1. Shell metacharacter detection (blocks piping/chaining)
 *   2. Allowed-command whitelist (first token must be in SAFE_SHELL_COMMANDS)
 *   3. Blocked-command scan (any token matching BLOCKED_COMMANDS is rejected)
 */

// ── Exports ──────────────────────────────────────────────────

/** Shell metacharacters that enable command chaining or subshell execution. */
export const SHELL_META_CHARS = /[;|&`$(){}!><\n\r\\]/;

/**
 * Commands allowed for agent shell_exec.
 * Intentionally excludes interpreters (node, npm, python, etc.).
 */
export const SAFE_SHELL_COMMANDS: ReadonlySet<string> = new Set([
  "ls", "cat", "head", "tail", "wc", "diff", "find",
  "grep", "sort", "uniq",
]);

/**
 * Commands blocked in any position within the command string.
 * Token-based check prevents `ls;rm` or similar bypass attempts.
 */
export const BLOCKED_COMMANDS: ReadonlySet<string> = new Set([
  "rm", "sudo", "chmod", "chown", "mkfs", "dd",
  "curl", "wget", "kill", "pkill", "killall",
  "mv", "cp", "sh", "bash", "zsh", "python",
  "perl", "ruby", "node", "npm", "npx",
  "eval", "exec", "source",
]);

// ── Types ────────────────────────────────────────────────────

export interface ShellValidationResult {
  valid: boolean;
  error?: string;
}

// ── Functions ────────────────────────────────────────────────

/**
 * Validate a shell command for safe execution.
 *
 * Three-stage validation:
 *   1. Reject if shell metacharacters are present (blocks piping, chaining, subshells)
 *   2. Reject if the first token is not in SAFE_SHELL_COMMANDS
 *   3. Reject if any token matches BLOCKED_COMMANDS
 */
export function validateShellCommand(command: string): ShellValidationResult {
  // Stage 1: Shell metacharacter check
  if (SHELL_META_CHARS.test(command)) {
    return {
      valid: false,
      error: "Command contains shell metacharacters (piping, chaining, or subshell operators are not allowed)",
    };
  }

  // Tokenize by whitespace
  const tokens = command.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { valid: false, error: "Empty command" };
  }

  // Strip path prefix from command (e.g., /usr/bin/ls -> ls)
  const baseCommand = tokens[0].replace(/^.*\//, "");

  // Stage 2: Whitelist check (first token)
  if (!SAFE_SHELL_COMMANDS.has(baseCommand)) {
    return {
      valid: false,
      error: `Command '${baseCommand}' is not allowed. Allowed: ${[...SAFE_SHELL_COMMANDS].join(", ")}`,
    };
  }

  // Stage 3: Blocked command scan (all tokens)
  for (const token of tokens) {
    const stripped = token.replace(/^.*\//, "");
    if (BLOCKED_COMMANDS.has(stripped)) {
      return {
        valid: false,
        error: `Command contains blocked token '${stripped}'`,
      };
    }
  }

  return { valid: true };
}

/**
 * Escape a string for safe use inside double quotes in a shell command.
 * Escapes: " $ ` \ !
 */
export function escapeShellArg(arg: string): string {
  return arg.replace(/["$`\\!]/g, "\\$&");
}
