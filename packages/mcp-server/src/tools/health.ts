import type { ProviderRegistry } from "@agestra/core";
import { existsSync, unlinkSync, rmSync } from "fs";
import { join } from "path";
import {
  generateClaudeMdSection,
  generateHooksConfig,
  updateClaudeMd,
  updateHooks,
  removeClaudeMdSection,
  removeHooks,
} from "./config-generator.js";
import {
  detectProviders,
  updateProvidersConfig,
  registerDetectedProviders,
} from "./provider-detector.js";

// ── Types ────────────────────────────────────────────────────

export interface HealthToolDeps {
  registry: ProviderRegistry;
  workspacePath?: string;
}

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// ── Tool definitions ─────────────────────────────────────────

export function getTools() {
  return [
    {
      name: "agestra_setup",
      description:
        "One-stop setup: detect providers, run health checks, and automatically generate CLAUDE.md section + Claude Code hooks. " +
        "Pass output_dir to control where config files are written (default: current directory).",
      inputSchema: {
        type: "object" as const,
        properties: {
          output_dir: {
            type: "string",
            description:
              "Directory to write CLAUDE.md and .claude/settings.local.json (default: current directory)",
          },
        },
        required: [] as string[],
      },
    },
    {
      name: "agestra_remove",
      description:
        "Remove all agestra-generated configuration: CLAUDE.md section (between version markers), " +
        "Claude Code hooks, providers.config.json, and optionally the .agestra/ runtime data directory.",
      inputSchema: {
        type: "object" as const,
        properties: {
          output_dir: {
            type: "string",
            description:
              "Directory where config files were written (default: current directory)",
          },
          remove_runtime_data: {
            type: "boolean",
            description:
              "Also remove .agestra/ runtime data (sessions, memory, workspace). Default: false",
          },
          remove_providers_config: {
            type: "boolean",
            description:
              "Also remove providers.config.json. Default: true",
          },
        },
        required: [] as string[],
      },
    },
  ];
}

// ── Handlers ─────────────────────────────────────────────────

async function handleAgestraSetup(
  args: Record<string, unknown>,
  deps: HealthToolDeps,
): Promise<McpToolResult> {
  const outputDir = (args.output_dir as string) || process.cwd();

  let text = `# Agestra Setup Report\n\n`;

  // ── Auto-detect providers ──────────────────────────────────

  const { results: detectionResults, providers: detectedProviders } = await detectProviders();

  // Update or create providers.config.json
  const configResult = updateProvidersConfig(outputDir, detectionResults, false);

  // Register detected providers into the registry (skips duplicates)
  registerDetectedProviders(detectedProviders, deps.registry);

  const allProviders = deps.registry.getAll();

  // ── Provider Detection ───────────────────────────────────

  text += `## Detected Providers\n\n`;

  if (detectionResults.length > 0) {
    for (const r of detectionResults) {
      const icon = r.available ? "OK" : "NOT FOUND";
      text += `- **${r.id}** (${r.type}): ${icon}\n`;
    }
    text += "\n";
  }

  text += `## Registered Providers\n\n`;

  if (allProviders.length === 0) {
    text += `No providers registered. You need at least one AI provider.\n\n`;
    text += `### Recommendations\n\n`;
    text += `1. **Ollama** (local): Install from https://ollama.com, then run \`ollama pull llama3\`\n`;
    text += `2. **Gemini** (cloud): Install Gemini CLI from https://github.com/google-gemini/gemini-cli\n`;
    text += `3. **Codex** (cloud): Install OpenAI Codex CLI\n\n`;
  } else {
    for (const provider of allProviders) {
      const available = provider.isAvailable();
      const statusLabel = available ? "OK" : "UNAVAILABLE";
      text += `- **${provider.id}** (${provider.type}): ${statusLabel}\n`;
    }
    text += "\n";
  }

  // ── Health Checks ────────────────────────────────────────

  text += `## Health Checks\n\n`;

  const healthResults = await Promise.all(
    allProviders.map(async (provider) => {
      try {
        const health = await provider.healthCheck();
        return {
          id: provider.id,
          status: health.status,
          message: health.message,
        };
      } catch (err) {
        return {
          id: provider.id,
          status: "error" as const,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  if (healthResults.length === 0) {
    text += `No providers to check.\n\n`;
  } else {
    for (const h of healthResults) {
      const icon =
        h.status === "ok" ? "OK" : h.status === "degraded" ? "DEGRADED" : "ERROR";
      text += `- **${h.id}:** ${icon}`;
      if (h.message) text += ` — ${h.message}`;
      text += "\n";
    }
    text += "\n";
  }

  // ── Model Details ───────────────────────────────────────

  const availableProviders = allProviders.filter((p) => p.isAvailable());

  const ollamaProviders = availableProviders.filter((p) => p.type === "ollama");
  if (ollamaProviders.length > 0) {
    text += `## Ollama Model Details\n\n`;
    text += `Use model size to estimate capability (parameter count):\n\n`;

    for (const p of ollamaProviders) {
      const caps = p.getCapabilities();
      for (const m of caps.models) {
        const sizeMatch = m.description.match(/\((\d+)GB\)/);
        const sizeGB = sizeMatch ? parseInt(sizeMatch[1], 10) : 0;
        let tier = "unknown";
        if (sizeGB > 0) {
          if (sizeGB < 3) tier = "simple (~1-3B params)";
          else if (sizeGB < 8) tier = "moderate (~3-7B params)";
          else if (sizeGB < 20) tier = "complex (~7-14B params)";
          else tier = "advanced (~14B+ params)";
        }
        text += `- **${m.name}:** ${m.description} → ${tier}`;
        if (m.strengths.length > 0) {
          text += ` [${m.strengths.join(", ")}]`;
        }
        text += "\n";
      }
    }
    text += "\n";
  }

  // ── Capabilities Summary ─────────────────────────────────

  text += `## Capabilities Summary\n\n`;
  text += `- **Total providers:** ${allProviders.length}\n`;
  text += `- **Available:** ${availableProviders.length}\n`;

  if (availableProviders.length > 0) {
    const allStrengths = new Set<string>();
    let totalModels = 0;
    for (const p of availableProviders) {
      const caps = p.getCapabilities();
      for (const s of caps.strengths) allStrengths.add(s);
      totalModels += caps.models.length;
    }
    text += `- **Total models:** ${totalModels}\n`;
    if (allStrengths.size > 0) {
      text += `- **Strengths:** ${[...allStrengths].join(", ")}\n`;
    }
  }
  text += "\n";

  // ── Workspace ────────────────────────────────────────────

  text += `## Workspace\n\n`;
  if (deps.workspacePath) {
    text += `- **Path:** ${deps.workspacePath}\n`;
  } else {
    text += `- **Path:** not configured\n`;
  }
  text += "\n";

  // ── Setup Status ─────────────────────────────────────────

  const hasErrors = healthResults.some((h) => h.status === "error");
  const hasAvailable = availableProviders.length > 0;

  text += `## Overall Status\n\n`;
  if (hasAvailable && !hasErrors) {
    text += `**Ready** — All systems operational.\n`;
  } else if (hasAvailable && hasErrors) {
    text += `**Partial** — Some providers have issues. Check health details above.\n`;
  } else {
    text += `**Not Ready** — No available providers. Follow the setup recommendations above.\n`;
  }
  text += "\n";

  // ── Config Generation ──────────────────────────────────────

  text += `## Generated Configuration\n\n`;

  const section = generateClaudeMdSection(deps.registry);
  const hooks = generateHooksConfig();

  const claudeMdResult = updateClaudeMd(outputDir, section, false);
  const hooksResult = updateHooks(outputDir, hooks, false);

  text += `**providers.config.json:** ${configResult.action} → ${configResult.path}\n`;
  text += `**CLAUDE.md:** ${claudeMdResult.action} → ${claudeMdResult.path}\n`;
  text += `**Hooks:** ${hooksResult.action} → ${hooksResult.path}\n\n`;

  const hookEvents = Object.keys(hooks);
  text += `Configured hooks: ${hookEvents.join(", ")}\n`;
  text += `- **SessionStart:** Provider status check\n`;
  text += `- **PreToolUse (git commit):** Interactive commit review\n`;
  text += `- **UserPromptSubmit:** Agestra tool suggestion choice\n`;
  text += `- **Stop:** Completion verification checklist\n`;

  return { content: [{ type: "text", text }] };
}

// ── Remove handler ──────────────────────────────────────────

async function handleAgestraRemove(
  args: Record<string, unknown>,
  _deps: HealthToolDeps,
): Promise<McpToolResult> {
  const outputDir = (args.output_dir as string) || process.cwd();
  const removeRuntimeData = (args.remove_runtime_data as boolean) ?? false;
  const removeProvidersConfig = (args.remove_providers_config as boolean) ?? true;

  let text = `# Agestra Remove Report\n\n`;

  // ── Remove CLAUDE.md section ──────────────────────────────
  const claudeMdResult = removeClaudeMdSection(outputDir);
  text += `## CLAUDE.md\n\n`;
  switch (claudeMdResult.action) {
    case "removed":
      text += `**Removed** agestra section from ${claudeMdResult.path}\n\n`;
      break;
    case "not_found":
      text += `No agestra section found in ${claudeMdResult.path}\n\n`;
      break;
    case "no_file":
      text += `File not found: ${claudeMdResult.path}\n\n`;
      break;
  }

  // ── Remove hooks ──────────────────────────────────────────
  const hooksResult = removeHooks(outputDir);
  text += `## Hooks\n\n`;
  switch (hooksResult.action) {
    case "removed":
      text += `**Removed** agestra hooks from ${hooksResult.path}\n`;
      text += `Events cleared: ${hooksResult.eventsCleared.join(", ")}\n\n`;
      break;
    case "not_found":
      text += `No agestra hooks found in ${hooksResult.path}\n\n`;
      break;
    case "no_file":
      text += `File not found: ${hooksResult.path}\n\n`;
      break;
  }

  // ── Remove providers.config.json ──────────────────────────
  text += `## providers.config.json\n\n`;
  if (removeProvidersConfig) {
    const configPath = join(outputDir, "providers.config.json");
    if (existsSync(configPath)) {
      unlinkSync(configPath);
      text += `**Removed** ${configPath}\n\n`;
    } else {
      text += `File not found: ${configPath}\n\n`;
    }
  } else {
    text += `Skipped (remove_providers_config: false)\n\n`;
  }

  // ── Remove runtime data ───────────────────────────────────
  text += `## Runtime Data (.agestra/)\n\n`;
  if (removeRuntimeData) {
    const runtimeDir = join(outputDir, ".agestra");
    if (existsSync(runtimeDir)) {
      rmSync(runtimeDir, { recursive: true, force: true });
      text += `**Removed** ${runtimeDir}\n\n`;
    } else {
      text += `Directory not found: ${runtimeDir}\n\n`;
    }
  } else {
    text += `Skipped (remove_runtime_data: false)\n\n`;
  }

  // ── Summary ───────────────────────────────────────────────
  const removed = [
    claudeMdResult.action === "removed" ? "CLAUDE.md section" : null,
    hooksResult.action === "removed" ? "hooks" : null,
    removeProvidersConfig ? "providers.config.json" : null,
    removeRuntimeData ? ".agestra/ data" : null,
  ].filter(Boolean);

  text += `## Summary\n\n`;
  if (removed.length > 0) {
    text += `Cleaned up: ${removed.join(", ")}\n`;
  } else {
    text += `Nothing to remove — agestra was not configured in this directory.\n`;
  }

  return { content: [{ type: "text", text }] };
}

// ── Dispatcher ───────────────────────────────────────────────

export async function handleTool(
  name: string,
  args: unknown,
  deps: HealthToolDeps,
): Promise<McpToolResult> {
  switch (name) {
    case "agestra_setup":
      return handleAgestraSetup((args as Record<string, unknown>) || {}, deps);
    case "agestra_remove":
      return handleAgestraRemove((args as Record<string, unknown>) || {}, deps);
    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
}
