/**
 * Sandboxed tool definitions for the AgentLoop.
 *
 * Each tool enforces path safety via safePath() from @agestra/core
 * and caps output size to prevent context overflow.
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { safePath } from "@agestra/core";
import { atomicWriteSync } from "@agestra/core";
import { runCli } from "@agestra/core";

// ── Types ────────────────────────────────────────────────────

export interface AgentToolParam {
  type: string;
  description: string;
  required?: boolean;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, AgentToolParam>;
  execute(args: Record<string, unknown>, baseDir: string): Promise<string>;
}

export interface OllamaToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

// ── Constants ────────────────────────────────────────────────

const MAX_READ_BYTES = 50 * 1024;       // 50 KB
const MAX_LIST_ENTRIES = 500;
const MAX_GREP_MATCHES = 100;
const MAX_SHELL_OUTPUT = 100 * 1024;     // 100 KB
const SHELL_TIMEOUT = 30_000;            // 30 seconds

const SHELL_ALLOWED_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "wc", "diff", "find",
  "grep", "sort", "uniq", "node", "npm",
]);

const SHELL_BLOCKED_PATTERNS = [
  "rm", "sudo", "chmod", "chown", "mkfs", "dd",
  "curl", "wget", "kill", "pkill", "killall",
  "mv", "cp",  // block by default for safety
];

// ── Tool implementations ────────────────────────────────────

const fileReadTool: AgentTool = {
  name: "file_read",
  description: "Read the contents of a file. Returns the text content.",
  parameters: {
    path: { type: "string", description: "File path relative to workspace", required: true },
    offset: { type: "number", description: "Line offset to start reading from (0-based)" },
    limit: { type: "number", description: "Maximum number of lines to read" },
  },
  async execute(args, baseDir) {
    const filePath = safePath(String(args.path ?? ""), baseDir);
    let content = readFileSync(filePath, "utf-8");

    // Apply line offset/limit
    if (args.offset !== undefined || args.limit !== undefined) {
      const lines = content.split("\n");
      const offset = Number(args.offset ?? 0);
      const limit = Number(args.limit ?? lines.length);
      content = lines.slice(offset, offset + limit).join("\n");
    }

    // Truncate if too large
    if (Buffer.byteLength(content, "utf-8") > MAX_READ_BYTES) {
      content = content.slice(0, MAX_READ_BYTES) + "\n... [truncated]";
    }

    return content;
  },
};

const fileWriteTool: AgentTool = {
  name: "file_write",
  description: "Write content to a file. Creates parent directories if needed. Overwrites existing files.",
  parameters: {
    path: { type: "string", description: "File path relative to workspace", required: true },
    content: { type: "string", description: "Content to write", required: true },
  },
  async execute(args, baseDir) {
    const filePath = safePath(String(args.path ?? ""), baseDir);
    const content = String(args.content ?? "");
    atomicWriteSync(filePath, content);
    return `File written: ${args.path} (${Buffer.byteLength(content, "utf-8")} bytes)`;
  },
};

const fileListTool: AgentTool = {
  name: "file_list",
  description: "List files and directories at the given path.",
  parameters: {
    path: { type: "string", description: "Directory path relative to workspace (default: '.')" },
    recursive: { type: "boolean", description: "List recursively (default: false)" },
  },
  async execute(args, baseDir) {
    const dirPath = safePath(String(args.path ?? "."), baseDir);
    const recursive = Boolean(args.recursive);
    const entries: string[] = [];

    function walk(dir: string, prefix: string): void {
      if (entries.length >= MAX_LIST_ENTRIES) return;
      const items = readdirSync(dir);
      for (const item of items) {
        if (entries.length >= MAX_LIST_ENTRIES) break;
        const fullPath = join(dir, item);
        const relPath = prefix ? `${prefix}/${item}` : item;
        try {
          const stat = statSync(fullPath);
          entries.push(stat.isDirectory() ? `${relPath}/` : relPath);
          if (recursive && stat.isDirectory()) {
            walk(fullPath, relPath);
          }
        } catch {
          // skip inaccessible entries
        }
      }
    }

    walk(dirPath, "");

    const suffix = entries.length >= MAX_LIST_ENTRIES
      ? `\n... [truncated at ${MAX_LIST_ENTRIES} entries]`
      : "";
    return entries.join("\n") + suffix;
  },
};

const grepSearchTool: AgentTool = {
  name: "grep_search",
  description: "Search file contents with a regex pattern. Returns matching lines with file paths and line numbers.",
  parameters: {
    pattern: { type: "string", description: "Regular expression pattern to search for", required: true },
    path: { type: "string", description: "Directory or file path to search in (default: '.')" },
    glob: { type: "string", description: "Glob pattern to filter files (e.g., '*.ts')" },
  },
  async execute(args, baseDir) {
    const pattern = String(args.pattern ?? "");
    const searchPath = safePath(String(args.path ?? "."), baseDir);

    const grepArgs = ["-rn"];
    if (args.glob) {
      grepArgs.push("--include", String(args.glob));
    }
    grepArgs.push(pattern, searchPath);

    try {
      const result = await runCli({
        command: "grep",
        args: grepArgs,
        timeout: SHELL_TIMEOUT,
        cwd: baseDir,
        maxBuffer: MAX_SHELL_OUTPUT,
      });

      const lines = result.stdout.split("\n").filter(Boolean);
      if (lines.length > MAX_GREP_MATCHES) {
        return lines.slice(0, MAX_GREP_MATCHES).join("\n") + `\n... [${lines.length - MAX_GREP_MATCHES} more matches]`;
      }
      return lines.join("\n") || "No matches found.";
    } catch {
      return "No matches found.";
    }
  },
};

const shellExecTool: AgentTool = {
  name: "shell_exec",
  description: "Execute a shell command. Only safe, read-oriented commands are allowed (ls, cat, head, tail, wc, diff, find, grep, sort, uniq, node, npm).",
  parameters: {
    command: { type: "string", description: "Shell command to execute", required: true },
  },
  async execute(args, baseDir) {
    const command = String(args.command ?? "").trim();
    if (!command) {
      return "Error: empty command";
    }

    // Extract the base command (first word)
    const baseCommand = command.split(/\s+/)[0].replace(/^.*\//, ""); // strip path prefix

    if (!SHELL_ALLOWED_COMMANDS.has(baseCommand)) {
      return `Error: command '${baseCommand}' is not allowed. Allowed: ${[...SHELL_ALLOWED_COMMANDS].join(", ")}`;
    }

    // Check for blocked patterns anywhere in the command
    for (const blocked of SHELL_BLOCKED_PATTERNS) {
      const regex = new RegExp(`(^|[\\s|;&])${blocked}(\\s|$|;|&|\\|)`, "i");
      if (regex.test(command)) {
        return `Error: command contains blocked pattern '${blocked}'`;
      }
    }

    try {
      const result = await runCli({
        command: "sh",
        args: ["-c", command],
        timeout: SHELL_TIMEOUT,
        cwd: baseDir,
        maxBuffer: MAX_SHELL_OUTPUT,
      });

      let output = result.stdout;
      if (result.stderr) {
        output += (output ? "\n" : "") + `[stderr] ${result.stderr}`;
      }
      if (result.exitCode !== 0) {
        output += `\n[exit code: ${result.exitCode}]`;
      }
      if (result.truncated) {
        output += "\n... [output truncated]";
      }
      return output || "(no output)";
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

// ── Factory & conversion ────────────────────────────────────

export function createDefaultTools(): AgentTool[] {
  return [fileReadTool, fileWriteTool, fileListTool, grepSearchTool, shellExecTool];
}

export function createReadOnlyTools(): AgentTool[] {
  return [fileReadTool, fileListTool, grepSearchTool];
}

export function toOllamaToolDefs(tools: AgentTool[]): OllamaToolDefinition[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: "object" as const,
        properties: t.parameters,
        required: Object.entries(t.parameters)
          .filter(([, param]) => param.required === true)
          .map(([k]) => k),
      },
    },
  }));
}
