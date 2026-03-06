import { execFileSync } from "child_process";
import type { ProviderRegistry } from "@agestra/core";
import { classifyOllamaComplexity } from "@agestra/core";

// ── Types ────────────────────────────────────────────────────

export interface EnvironmentToolDeps {
  registry: ProviderRegistry;
}

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

interface CliToolInfo {
  available: boolean;
  path: string | null;
}

interface OllamaModelInfo {
  name: string;
  size_gb: number;
  tier: string;
}

interface EnvironmentCheckResult {
  providers: Record<string, {
    available: boolean;
    cli_path?: string | null;
    autonomous_capable?: boolean;
    models?: OllamaModelInfo[];
  }>;
  infrastructure: {
    tmux: CliToolInfo;
    git: { available: boolean; worktree_support: boolean };
  };
  capabilities: {
    can_autonomous_work: boolean;
    can_tmux_visible: boolean;
    can_parallel_workers: boolean;
    max_parallel_workers: number;
    available_modes: string[];
  };
}

// ── Helpers ─────────────────────────────────────────────────

function whichCommand(command: string): string | null {
  try {
    return execFileSync("which", [command], {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 5_000,
    }).trim() || null;
  } catch {
    return null;
  }
}

function checkGitWorktreeSupport(): boolean {
  try {
    execFileSync("git", ["worktree", "list"], {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

// ── Tool definitions ────────────────────────────────────────

export function getTools() {
  return [
    {
      name: "environment_check",
      description:
        "Check installed AI CLI tools (codex, gemini), infrastructure (tmux, git worktree), and Ollama models. " +
        "Returns a capability map showing available v3 orchestration modes. " +
        "Results are cached per session — call with force_refresh to re-check.",
      inputSchema: {
        type: "object" as const,
        properties: {
          force_refresh: {
            type: "boolean",
            description: "Force re-check even if cached (default: false)",
          },
        },
        required: [] as string[],
      },
    },
  ];
}

// ── Cache ───────────────────────────────────────────────────

let _cached: EnvironmentCheckResult | null = null;

/**
 * Reset cache (for testing).
 */
export function resetCache(): void {
  _cached = null;
}

// ── Handler ─────────────────────────────────────────────────

async function handleEnvironmentCheck(
  args: { force_refresh?: boolean },
  deps: EnvironmentToolDeps,
): Promise<McpToolResult> {
  if (_cached && !args.force_refresh) {
    return { content: [{ type: "text", text: formatResult(_cached) }] };
  }

  const codexPath = whichCommand("codex");
  const geminiPath = whichCommand("gemini");
  const tmuxPath = whichCommand("tmux");
  const gitPath = whichCommand("git");

  // Detect Ollama models from registered provider
  const ollamaModels: OllamaModelInfo[] = [];
  const providers = deps.registry.getAll();
  const ollamaProvider = providers.find((p) => p.id === "ollama");
  if (ollamaProvider?.isAvailable()) {
    const caps = ollamaProvider.getCapabilities();
    for (const model of caps.models) {
      const sizeGb = (model as any).sizeGb ?? 0;
      ollamaModels.push({
        name: model.name,
        size_gb: sizeGb,
        tier: classifyOllamaComplexity(sizeGb),
      });
    }
  }

  const hasAutonomousCli = codexPath !== null || geminiPath !== null;
  const hasTmux = tmuxPath !== null;
  const hasGitWorktree = gitPath !== null && checkGitWorktreeSupport();

  const modes: string[] = ["claude_only"];
  if (providers.some((p) => p.id !== "ollama" && p.isAvailable()) || ollamaModels.length > 0) {
    modes.push("independent", "debate");
  }
  if (hasAutonomousCli && hasGitWorktree) {
    modes.push("team");
  }

  const result: EnvironmentCheckResult = {
    providers: {
      ollama: {
        available: ollamaProvider?.isAvailable() ?? false,
        models: ollamaModels,
      },
      gemini: {
        available: geminiPath !== null,
        cli_path: geminiPath,
        autonomous_capable: geminiPath !== null,
      },
      codex: {
        available: codexPath !== null,
        cli_path: codexPath,
        autonomous_capable: codexPath !== null,
      },
    },
    infrastructure: {
      tmux: { available: hasTmux, path: tmuxPath },
      git: { available: gitPath !== null, worktree_support: hasGitWorktree },
    },
    capabilities: {
      can_autonomous_work: hasAutonomousCli && hasGitWorktree,
      can_tmux_visible: hasTmux,
      can_parallel_workers: hasAutonomousCli && hasGitWorktree,
      max_parallel_workers: hasAutonomousCli ? 3 : 0,
      available_modes: modes,
    },
  };

  _cached = result;
  return { content: [{ type: "text", text: formatResult(result) }] };
}

function formatResult(result: EnvironmentCheckResult): string {
  let text = "# Environment Check\n\n";

  text += "## Providers\n\n";
  for (const [id, info] of Object.entries(result.providers)) {
    const status = info.available ? "Available" : "Not found";
    text += `### ${id}\n- **Status:** ${status}\n`;
    if (info.cli_path) text += `- **CLI Path:** ${info.cli_path}\n`;
    if (info.autonomous_capable) text += `- **Autonomous:** Yes\n`;
    if (info.models && info.models.length > 0) {
      text += `- **Models:**\n`;
      for (const m of info.models) {
        text += `  - ${m.name} (${m.size_gb.toFixed(1)} GB, tier: ${m.tier})\n`;
      }
    }
    text += "\n";
  }

  text += "## Infrastructure\n\n";
  text += `- **tmux:** ${result.infrastructure.tmux.available ? `Available (${result.infrastructure.tmux.path})` : "Not found"}\n`;
  text += `- **git:** ${result.infrastructure.git.available ? "Available" : "Not found"}`;
  if (result.infrastructure.git.available) {
    text += ` (worktree: ${result.infrastructure.git.worktree_support ? "supported" : "not supported"})`;
  }
  text += "\n\n";

  text += "## Capabilities\n\n";
  text += `- **Autonomous work:** ${result.capabilities.can_autonomous_work ? "Yes" : "No"}\n`;
  text += `- **tmux visible:** ${result.capabilities.can_tmux_visible ? "Yes" : "No"}\n`;
  text += `- **Parallel workers:** ${result.capabilities.can_parallel_workers ? `Yes (max ${result.capabilities.max_parallel_workers})` : "No"}\n`;
  text += `- **Available modes:** ${result.capabilities.available_modes.join(", ")}\n`;

  return text;
}

// ── Dispatcher ──────────────────────────────────────────────

export async function handleTool(
  name: string,
  args: unknown,
  deps: EnvironmentToolDeps,
): Promise<McpToolResult> {
  switch (name) {
    case "environment_check":
      return handleEnvironmentCheck((args ?? {}) as { force_refresh?: boolean }, deps);
    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
}
