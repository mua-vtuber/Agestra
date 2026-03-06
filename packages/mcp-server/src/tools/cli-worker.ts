import type {
  CliWorkerManager,
  WorkerSpawnArgs,
  WorkerInfo,
  WorkerStatusResult,
  WorkerCollectResult,
} from "@agestra/core";

// ── Types ────────────────────────────────────────────────────

export interface CliWorkerToolDeps {
  cliWorkerManager?: CliWorkerManager;
}

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// ── Tool definitions ─────────────────────────────────────────

export function getTools() {
  return [
    {
      name: "cli_worker_spawn",
      description:
        "Spawn a CLI AI worker (codex or gemini) in autonomous mode. " +
        "The worker runs in the background and can be monitored with cli_worker_status.",
      inputSchema: {
        type: "object" as const,
        properties: {
          provider: {
            type: "string",
            enum: ["codex", "gemini"],
            description: "CLI provider to use (codex or gemini)",
          },
          task_description: {
            type: "string",
            description: "Natural-language description of the task for the worker",
          },
          working_dir: {
            type: "string",
            description: "Absolute path to the working directory for the worker",
          },
          files_to_read: {
            type: "array",
            items: { type: "string" },
            description: "Files the worker should read for context (optional)",
          },
          files_to_modify: {
            type: "array",
            items: { type: "string" },
            description: "Files the worker is allowed to modify (optional)",
          },
          constraints: {
            type: "string",
            description: "Additional constraints or rules for the worker (optional)",
          },
          success_criteria: {
            type: "array",
            items: { type: "string" },
            description: "Criteria to determine if the task succeeded (optional)",
          },
          timeout_minutes: {
            type: "number",
            description: "Timeout in minutes (optional)",
          },
        },
        required: ["provider", "task_description", "working_dir"],
      },
    },
    {
      name: "cli_worker_status",
      description:
        "Get the status of a CLI worker by ID, or list all tracked workers if no ID is given.",
      inputSchema: {
        type: "object" as const,
        properties: {
          worker_id: {
            type: "string",
            description: "Worker ID to check (omit to list all workers)",
          },
        },
        required: [] as string[],
      },
    },
    {
      name: "cli_worker_collect",
      description:
        "Collect results from a completed or failed CLI worker. " +
        "Returns full output, git diff, and changed files.",
      inputSchema: {
        type: "object" as const,
        properties: {
          worker_id: {
            type: "string",
            description: "Worker ID to collect results from",
          },
        },
        required: ["worker_id"],
      },
    },
    {
      name: "cli_worker_stop",
      description:
        "Stop a running CLI worker. Sends SIGTERM, then SIGKILL after 5 seconds.",
      inputSchema: {
        type: "object" as const,
        properties: {
          worker_id: {
            type: "string",
            description: "Worker ID to stop",
          },
        },
        required: ["worker_id"],
      },
    },
  ];
}

// ── Helpers ──────────────────────────────────────────────────

function ensureManager(deps: CliWorkerToolDeps): CliWorkerManager {
  if (!deps.cliWorkerManager) {
    throw new Error("CliWorkerManager not initialized — cli_worker tools are unavailable");
  }
  return deps.cliWorkerManager;
}

function textResult(text: string, isError?: boolean): McpToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError } : {}) };
}

function formatWorkerInfo(info: WorkerInfo): string {
  let text = `# Worker Spawned\n\n`;
  text += `- **Worker ID:** ${info.workerId}\n`;
  text += `- **Provider:** ${info.provider}\n`;
  text += `- **State:** ${info.state}\n`;
  text += `- **PID:** ${info.pid ?? "N/A"}\n`;
  if (info.worktreeBranch) {
    text += `- **Worktree Branch:** ${info.worktreeBranch}\n`;
  }
  return text;
}

function formatWorkerStatus(status: WorkerStatusResult): string {
  let text = `# Worker Status\n\n`;
  text += `- **Worker ID:** ${status.workerId}\n`;
  text += `- **Provider:** ${status.provider}\n`;
  text += `- **State:** ${status.state}\n`;
  text += `- **Elapsed:** ${status.elapsedSeconds}s\n`;
  text += `- **PID:** ${status.pid ?? "N/A"}\n`;
  text += `- **Retry Count:** ${status.retryCount}\n`;
  if (status.worktreeBranch) {
    text += `- **Worktree Branch:** ${status.worktreeBranch}\n`;
  }
  if (status.outputTail) {
    text += `\n## Recent Output\n\n\`\`\`\n${status.outputTail}\n\`\`\`\n`;
  }
  return text;
}

function formatWorkerList(workers: WorkerInfo[]): string {
  if (workers.length === 0) {
    return "# Workers\n\nNo tracked workers.";
  }

  let text = `# Workers (${workers.length})\n\n`;
  for (const w of workers) {
    text += `- **${w.workerId}** — ${w.provider} — ${w.state}`;
    if (w.pid) text += ` (PID ${w.pid})`;
    text += "\n";
  }
  return text;
}

function formatCollectResult(result: WorkerCollectResult): string {
  let text = `# Worker Results\n\n`;
  text += `- **Worker ID:** ${result.workerId}\n`;
  text += `- **State:** ${result.state}\n`;
  text += `- **Exit Code:** ${result.exitCode ?? "N/A"}\n`;
  if (result.worktreeBranch) {
    text += `- **Worktree Branch:** ${result.worktreeBranch}\n`;
  }
  if (result.filesChanged.length > 0) {
    text += `\n## Files Changed\n\n`;
    for (const f of result.filesChanged) {
      text += `- ${f}\n`;
    }
  }
  if (result.gitDiff) {
    text += `\n## Git Diff\n\n\`\`\`diff\n${result.gitDiff}\n\`\`\`\n`;
  }
  if (result.outputFull) {
    text += `\n## Full Output\n\n\`\`\`\n${result.outputFull}\n\`\`\`\n`;
  }
  return text;
}

// ── Handlers ─────────────────────────────────────────────────

interface SpawnArgs {
  provider: "codex" | "gemini";
  task_description: string;
  working_dir: string;
  files_to_read?: string[];
  files_to_modify?: string[];
  constraints?: string;
  success_criteria?: string[];
  timeout_minutes?: number;
}

async function handleSpawn(
  args: SpawnArgs,
  deps: CliWorkerToolDeps,
): Promise<McpToolResult> {
  const manager = ensureManager(deps);

  const spawnArgs: WorkerSpawnArgs = {
    provider: args.provider,
    taskDescription: args.task_description,
    workingDir: args.working_dir,
    filesToRead: args.files_to_read,
    filesToModify: args.files_to_modify,
    constraints: args.constraints,
    successCriteria: args.success_criteria,
    timeoutMinutes: args.timeout_minutes,
  };

  try {
    const info = manager.spawn(spawnArgs);
    return textResult(formatWorkerInfo(info));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return textResult(`Error spawning worker: ${message}`, true);
  }
}

async function handleStatus(
  args: { worker_id?: string },
  deps: CliWorkerToolDeps,
): Promise<McpToolResult> {
  const manager = ensureManager(deps);

  if (!args.worker_id) {
    const workers = manager.listAll();
    return textResult(formatWorkerList(workers));
  }

  const status = manager.getStatus(args.worker_id);
  if (!status) {
    return textResult(`Worker not found: ${args.worker_id}`, true);
  }

  return textResult(formatWorkerStatus(status));
}

async function handleCollect(
  args: { worker_id: string },
  deps: CliWorkerToolDeps,
): Promise<McpToolResult> {
  const manager = ensureManager(deps);

  const result = manager.collect(args.worker_id);
  if (!result) {
    return textResult(`Worker not found: ${args.worker_id}`, true);
  }

  return textResult(formatCollectResult(result));
}

async function handleStop(
  args: { worker_id: string },
  deps: CliWorkerToolDeps,
): Promise<McpToolResult> {
  const manager = ensureManager(deps);

  manager.stop(args.worker_id);
  return textResult(`Stop signal sent to worker: ${args.worker_id}`);
}

// ── Dispatcher ───────────────────────────────────────────────

export async function handleTool(
  name: string,
  args: unknown,
  deps: CliWorkerToolDeps,
): Promise<McpToolResult> {
  try {
    switch (name) {
      case "cli_worker_spawn":
        return await handleSpawn((args ?? {}) as SpawnArgs, deps);
      case "cli_worker_status":
        return await handleStatus((args ?? {}) as { worker_id?: string }, deps);
      case "cli_worker_collect":
        return await handleCollect((args ?? {}) as { worker_id: string }, deps);
      case "cli_worker_stop":
        return await handleStop((args ?? {}) as { worker_id: string }, deps);
      default:
        return textResult(`Unknown tool: ${name}`, true);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return textResult(`Error: ${message}`, true);
  }
}
