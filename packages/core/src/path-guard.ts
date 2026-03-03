import { resolve, relative } from "path";

/**
 * Validates that a resolved path is within the allowed base directory.
 * Prevents path traversal attacks (e.g., ../../etc/passwd).
 */
export function isPathWithin(filePath: string, baseDir: string): boolean {
  const resolved = resolve(baseDir, filePath);
  const rel = relative(baseDir, resolved);
  return rel !== "" && !rel.startsWith("..");
}

/**
 * Resolves and validates a file path against the base directory.
 * Throws if the path escapes the base directory.
 */
export function safePath(filePath: string, baseDir: string): string {
  const resolved = resolve(baseDir, filePath);
  const rel = relative(baseDir, resolved);
  if (rel.startsWith("..")) {
    throw new Error(`Path traversal blocked: ${filePath} escapes ${baseDir}`);
  }
  return resolved;
}

/**
 * Validates a job ID matches the expected format: provider-timestamp-hex
 * Prevents directory traversal via crafted job IDs.
 */
const JOB_ID_PATTERN = /^[a-zA-Z0-9_-]+-\d+-[a-f0-9]{6}$/;

export function isValidJobId(jobId: string): boolean {
  return JOB_ID_PATTERN.test(jobId);
}

/**
 * Validates a CLI command against an allowlist of known safe commands.
 */
const ALLOWED_CLI_COMMANDS = new Set([
  "gemini",
  "codex",
  "npx",
  "node",
]);

export function isAllowedCliCommand(command: string): boolean {
  return ALLOWED_CLI_COMMANDS.has(command);
}
