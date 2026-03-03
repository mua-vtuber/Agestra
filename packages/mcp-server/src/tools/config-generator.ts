import { z } from "zod";
import { readFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { atomicWriteSync } from "@agestra/core";
import type { ProviderRegistry } from "@agestra/core";

// ── Constants ───────────────────────────────────────────────

const MCP_NAME = "agestra";
const MCP_VERSION = "4.0.0";
const SECTION_BEGIN = `<!-- [${MCP_NAME}:v${MCP_VERSION}] BEGIN -->`;
const SECTION_END = `<!-- [${MCP_NAME}:v${MCP_VERSION}] END -->`;
const SECTION_BEGIN_RE = /<!-- \[agestra:v[\d.]+\] BEGIN -->/;
const SECTION_END_RE = /<!-- \[agestra:v[\d.]+\] END -->/;
const HOOK_MARKER_RE = /\[agestra:v[\d.]+\]/;

// ── Zod schemas ─────────────────────────────────────────────

const GenerateConfigSchema = z.object({
  output_dir: z
    .string()
    .optional()
    .describe("Directory to write config files (default: current directory)"),
  dry_run: z
    .boolean()
    .optional()
    .default(true)
    .describe("If true, only show generated content without writing"),
});

// ── Types ────────────────────────────────────────────────────

export interface ConfigGenToolDeps {
  registry: ProviderRegistry;
}

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// ── Tool definitions ─────────────────────────────────────────

export function getTools() {
  return [
    {
      name: "agestra_generate_config",
      description:
        "Generate CLAUDE.md section and Claude Code hooks for the current environment. " +
        "Detects providers and creates configuration with MCP version markers for update management. " +
        "Use dry_run=true (default) to preview, dry_run=false to write files.",
      inputSchema: {
        type: "object" as const,
        properties: {
          output_dir: {
            type: "string",
            description:
              "Directory to write config files (default: current directory)",
          },
          dry_run: {
            type: "boolean",
            description:
              "If true, only show generated content without writing (default: true)",
          },
        },
        required: [] as string[],
      },
    },
  ];
}

// ── CLAUDE.md Section Generator ──────────────────────────────

function estimateParams(sizeBytes: number): string {
  const gb = sizeBytes / 1e9;
  if (gb < 3) return "~1-3B params";
  if (gb < 8) return "~3-7B params";
  if (gb < 20) return "~7-14B params";
  return "~14B+ params";
}

export function generateClaudeMdSection(
  registry: ProviderRegistry,
): string {
  const providers = registry.getAll();

  let s = `${SECTION_BEGIN}\n`;
  s += `## Agestra — AI Provider Integration (v${MCP_VERSION})\n\n`;

  // ── Provider list ──────────────────────────────────────────

  s += `### Available Providers\n\n`;

  if (providers.length === 0) {
    s += `No providers configured. Run \`agestra_setup\` for installation guidance.\n\n`;
  } else {
    for (const p of providers) {
      const status = p.isAvailable() ? "Active" : "Unavailable";
      const caps = p.getCapabilities();

      s += `**${p.id}** (${p.type}) — ${status}\n`;

      if (p.type === "ollama" && caps.models.length > 0) {
        for (const m of caps.models) {
          // Extract size from description like "Ollama model (4GB)"
          const sizeMatch = m.description.match(/\((\d+)GB\)/);
          const sizeGB = sizeMatch ? parseInt(sizeMatch[1], 10) : 0;
          const params = sizeGB > 0 ? estimateParams(sizeGB * 1e9) : "";
          s += `  - ${m.name}: ${m.description}`;
          if (params) s += ` (${params})`;
          if (m.strengths.length > 0) {
            s += ` [${m.strengths.join(", ")}]`;
          }
          s += `\n`;
        }
      }
      s += `\n`;
    }
  }

  // ── Capability guidelines ──────────────────────────────────

  s += `### Provider Capability Guidelines\n\n`;

  s += `**Ollama (Local Models)**\n`;
  s += `Judge model capability by parameter count (estimated from model size):\n`;
  s += `- < 3GB (~1-3B params): Simple tasks — formatting, pattern matching, basic transformations\n`;
  s += `- 3-8GB (~3-7B params): Moderate tasks — code review, simple analysis, summarization\n`;
  s += `- 8-20GB (~7-14B params): Complex tasks — code generation, detailed analysis, multi-step reasoning\n`;
  s += `- > 20GB (~14B+ params): Advanced tasks — architecture design, complex refactoring\n\n`;
  s += `Models are frequently added/removed by users. Always check \`ollama_models\` for current list before task assignment.\n\n`;

  s += `**Gemini / Codex (Cloud)**\n`;
  s += `Full-capability agents. Use for complex tasks, parallel work, and as validators.\n\n`;

  // ── Auto-Routing ───────────────────────────────────────────

  s += `### Auto-Routing Guidelines\n\n`;
  s += `- Simple tasks (formatting, pattern matching): Ollama local model preferred\n`;
  s += `- Moderate tasks (code review, summarization): Ollama >= 3GB or cloud\n`;
  s += `- Complex tasks (architecture, refactoring): Cloud providers (Gemini, Codex)\n`;
  s += `- No providers available: Handle directly, do not suggest agestra tools\n\n`;

  // ── Error handling ─────────────────────────────────────────

  s += `### Error Handling\n\n`;
  s += `**429 Rate Limit:**\n`;
  s += `1. Detect: Only known after receiving error response\n`;
  s += `2. Deactivate: Mark provider as unavailable for this session\n`;
  s += `3. Notify: Inform user which provider hit rate limit\n`;
  s += `4. Redirect: Immediately route remaining work to other available providers\n`;
  s += `5. Do NOT wait for rate limit reset\n\n`;

  // ── Proactive Suggestions ─────────────────────────────────

  s += `### When to Suggest Agestra Tools\n\n`;

  s += `**Hook-triggered choice:** When a \`AGESTRA_SUGGESTION\` marker appears from the UserPromptSubmit hook, `;
  s += `present the user with two choices:\n`;
  s += `1. Claude Code handles it alone\n`;
  s += `2. Multi-AI analysis (parallel processing with available providers)\n\n`;
  s += `If no providers are available, skip the choice and proceed directly.\n\n`;

  s += `**Manual suggestion:** Even without the hook trigger, suggest agestra tools naturally `;
  s += `when the user's intent clearly matches a pattern below. Suggest once. If declined, do not repeat.\n\n`;

  s += `**Language note:** The examples below are in English, but these triggers apply to ANY language. `;
  s += `Match by semantic intent, not literal keywords — e.g. "코드 리뷰해줘", "revisa este código", `;
  s += `"コードレビューして" all match "code review". Respond in the user's language.\n\n`;

  s += `| Intent | Suggest | When |\n`;
  s += `|---|---|---|\n`;
  s += `| Code review, review request | \`agent_debate_start\` or \`workspace_create_review\` | User asks to review code, PR, or implementation |\n`;
  s += `| Second opinion, other perspectives | \`ai_compare\` or \`agent_debate_start\` | User wants multiple viewpoints on a decision |\n`;
  s += `| Validation, verification, cross-check | \`agent_cross_validate\` | User wants to confirm correctness of work output |\n`;
  s += `| Speed up, parallelize, split work | \`agent_dispatch\` | User wants faster execution or has independent tasks |\n`;
  s += `| Past experience, history, previous attempts | \`memory_search\` or \`memory_dead_ends\` | User asks about prior work or known issues |\n`;
  s += `| Remember this, save for later | \`memory_store\` | User wants to persist knowledge across sessions |\n`;
  s += `| Mention a provider by name (Gemini, Codex, Ollama) | \`ai_chat\` or \`agent_assign_task\` | Route directly to the named provider |\n`;
  s += `| Architecture review, design discussion | \`agent_debate_start\` | Structured multi-AI discussion on design choices |\n`;
  s += `| Compare options, which is better | \`ai_compare\` | Side-by-side comparison from multiple providers |\n`;
  s += `| Large refactoring, many files to change | \`agent_dispatch\` | Split by file/module for parallel processing |\n`;
  s += `| About to commit, create PR, finalize work | \`agent_cross_validate\` | Pre-commit validation by other AI providers |\n\n`;

  s += `**Tone:** Suggest once, concisely, in the user's language. If declined or ignored, do not repeat.\n\n`;

  // ── Completion criteria ────────────────────────────────────

  s += `### Completion Verification\n\n`;
  s += `Before marking work complete, verify:\n`;
  s += `1. **Spec compliance**: Built according to specifications/documentation\n`;
  s += `2. **System integration**: Connected to existing systems correctly\n`;
  s += `3. **Accessibility**: Accessible via UI/API to end users\n`;
  s += `4. **Tests**: Pass with evidence (test output)\n\n`;

  // ── Memory ─────────────────────────────────────────────────

  s += `### Memory System\n\n`;
  s += `Failed approaches are automatically recorded as \`dead_end\` nodes.\n`;
  s += `Use \`memory_dead_ends\` to check before starting work.\n`;
  s += `Use \`memory_store\` to save findings for future sessions.\n\n`;

  s += SECTION_END;

  return s;
}

// ── Hooks Generator ──────────────────────────────────────────

export function generateHooksConfig(): Record<string, unknown[]> {
  const marker = `[${MCP_NAME}:v${MCP_VERSION}]`;

  return {
    SessionStart: [
      {
        matcher: "startup",
        hooks: [
          {
            type: "command" as const,
            command: `echo "${marker} Session started. Use agestra_setup to check provider status."`,
          },
        ],
      },
    ],
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [
          {
            type: "command" as const,
            command:
              `INPUT=$(cat); if echo "$INPUT" | grep -q '"command".*git commit'; then ` +
              `echo '${marker} Commit detected. Run agestra_setup to check provider status.'; fi`,
          },
        ],
      },
    ],
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: "command" as const,
            command:
              `INPUT=$(cat); if echo "$INPUT" | grep -qiE ` +
              `'리뷰|분석|설계|검토|조사|개선|아이디어|비교|검증|확인해|살펴|평가|` +
              `review|analy[sz]e|design|architect|investigate|improve|idea|compare|verif|valid|refactor|evaluat|assess|` +
              `レビュー|設計|検討'; then ` +
              `echo '${marker} AGESTRA_SUGGESTION: The user intent matches a agestra-capable task. ` +
              `Present two choices: (1) Claude Code handles it alone, (2) Multi-AI analysis with available providers.'; fi`,
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          {
            type: "prompt" as const,
            prompt:
              `${marker} You are evaluating whether Claude Code should stop. ` +
              `Context: $ARGUMENTS\n\n` +
              `Check if ALL 4 criteria are verified in the conversation:\n` +
              `1. Spec compliance  2. System integration  3. Accessibility  4. Tests pass with evidence\n\n` +
              `If stop_hook_active is true, respond {"ok": true}.\n` +
              `If all criteria verified, respond {"ok": true}.\n` +
              `Otherwise respond {"ok": false, "reason": "Missing: [list]"}.`,
          },
        ],
      },
    ],
  };
}

// ── File Update Logic ────────────────────────────────────────

export function updateClaudeMd(
  outputDir: string,
  section: string,
  dryRun: boolean,
): { action: "created" | "appended" | "replaced"; path: string } {
  const claudeMdPath = join(outputDir, "CLAUDE.md");

  if (existsSync(claudeMdPath)) {
    const existing = readFileSync(claudeMdPath, "utf-8");

    const beginMatch = existing.match(SECTION_BEGIN_RE);
    const endMatch = existing.match(SECTION_END_RE);

    if (beginMatch && endMatch) {
      const beginIdx = existing.indexOf(beginMatch[0]);
      const endIdx = existing.indexOf(endMatch[0]) + endMatch[0].length;
      const updated =
        existing.substring(0, beginIdx) + section + existing.substring(endIdx);

      if (!dryRun) atomicWriteSync(claudeMdPath, updated);
      return { action: "replaced", path: claudeMdPath };
    } else {
      const updated = existing.trimEnd() + "\n\n" + section + "\n";
      if (!dryRun) atomicWriteSync(claudeMdPath, updated);
      return { action: "appended", path: claudeMdPath };
    }
  } else {
    if (!dryRun) atomicWriteSync(claudeMdPath, section + "\n");
    return { action: "created", path: claudeMdPath };
  }
}

export function updateHooks(
  outputDir: string,
  hooks: Record<string, unknown[]>,
  dryRun: boolean,
): { action: "created" | "updated"; path: string } {
  const settingsDir = join(outputDir, ".claude");
  const settingsPath = join(settingsDir, "settings.local.json");

  let existing: Record<string, unknown> = {};

  if (existsSync(settingsPath)) {
    try {
      existing = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      existing = {};
    }
  }

  const existingHooks = (existing.hooks || {}) as Record<string, unknown[]>;

  for (const [event, newEntries] of Object.entries(hooks)) {
    const eventHooks = existingHooks[event] || [];

    // Remove old agestra hooks (any version, both old and new format)
    const filtered = eventHooks.filter((entry: any) => {
      // New format: { matcher, hooks: [...] }
      if (Array.isArray(entry.hooks)) {
        return !entry.hooks.some((h: any) => {
          const text = h.prompt || h.command || "";
          return HOOK_MARKER_RE.test(text);
        });
      }
      // Old format: { type, prompt/command }
      const text = entry.prompt || entry.command || "";
      return !HOOK_MARKER_RE.test(text);
    });

    filtered.push(...newEntries);
    existingHooks[event] = filtered;
  }

  existing.hooks = existingHooks;
  const action = existsSync(settingsPath) ? "updated" : "created";

  if (!dryRun) {
    mkdirSync(settingsDir, { recursive: true });
    atomicWriteSync(settingsPath, JSON.stringify(existing, null, 2));
  }

  return { action, path: settingsPath };
}

// ── Removal Logic ───────────────────────────────────────────

export function removeClaudeMdSection(
  outputDir: string,
): { action: "removed" | "not_found" | "no_file"; path: string } {
  const claudeMdPath = join(outputDir, "CLAUDE.md");

  if (!existsSync(claudeMdPath)) {
    return { action: "no_file", path: claudeMdPath };
  }

  const existing = readFileSync(claudeMdPath, "utf-8");
  const beginMatch = existing.match(SECTION_BEGIN_RE);
  const endMatch = existing.match(SECTION_END_RE);

  if (!beginMatch || !endMatch) {
    return { action: "not_found", path: claudeMdPath };
  }

  const beginIdx = existing.indexOf(beginMatch[0]);
  const endIdx = existing.indexOf(endMatch[0]) + endMatch[0].length;

  // Remove the section and any surrounding blank lines
  let updated = existing.substring(0, beginIdx) + existing.substring(endIdx);
  updated = updated.replace(/\n{3,}/g, "\n\n").trim();

  if (updated.length === 0) {
    // File is now empty — remove it
    unlinkSync(claudeMdPath);
  } else {
    atomicWriteSync(claudeMdPath, updated + "\n");
  }

  return { action: "removed", path: claudeMdPath };
}

export function removeHooks(
  outputDir: string,
): { action: "removed" | "not_found" | "no_file"; path: string; eventsCleared: string[] } {
  const settingsPath = join(outputDir, ".claude", "settings.local.json");

  if (!existsSync(settingsPath)) {
    return { action: "no_file", path: settingsPath, eventsCleared: [] };
  }

  let existing: Record<string, unknown>;
  try {
    existing = JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch {
    return { action: "not_found", path: settingsPath, eventsCleared: [] };
  }

  const existingHooks = (existing.hooks || {}) as Record<string, unknown[]>;
  const eventsCleared: string[] = [];

  for (const [event, entries] of Object.entries(existingHooks)) {
    const before = entries.length;
    const filtered = entries.filter((entry: any) => {
      if (Array.isArray(entry.hooks)) {
        return !entry.hooks.some((h: any) => {
          const text = h.prompt || h.command || "";
          return HOOK_MARKER_RE.test(text);
        });
      }
      const text = entry.prompt || entry.command || "";
      return !HOOK_MARKER_RE.test(text);
    });

    if (filtered.length < before) {
      eventsCleared.push(event);
    }

    if (filtered.length === 0) {
      delete existingHooks[event];
    } else {
      existingHooks[event] = filtered;
    }
  }

  if (eventsCleared.length === 0) {
    return { action: "not_found", path: settingsPath, eventsCleared: [] };
  }

  // Clean up: if hooks object is now empty, remove it
  if (Object.keys(existingHooks).length === 0) {
    delete existing.hooks;
  } else {
    existing.hooks = existingHooks;
  }

  // If the entire settings object is now empty, remove the file
  if (Object.keys(existing).length === 0) {
    unlinkSync(settingsPath);
  } else {
    atomicWriteSync(settingsPath, JSON.stringify(existing, null, 2));
  }

  return { action: "removed", path: settingsPath, eventsCleared };
}

// ── Handler ──────────────────────────────────────────────────

async function handleGenerateConfig(
  args: unknown,
  deps: ConfigGenToolDeps,
): Promise<McpToolResult> {
  const parsed = GenerateConfigSchema.parse(args);
  const outputDir = parsed.output_dir || process.cwd();
  const dryRun = parsed.dry_run;

  const section = generateClaudeMdSection(deps.registry);
  const hooks = generateHooksConfig();

  const claudeMdResult = updateClaudeMd(outputDir, section, dryRun);
  const hooksResult = updateHooks(outputDir, hooks, dryRun);

  let text = `# Configuration Generated\n\n`;
  text += `**Mode:** ${dryRun ? "Dry run (preview only)" : "Written to disk"}\n`;
  text += `**MCP:** ${MCP_NAME} v${MCP_VERSION}\n\n`;

  text += `## CLAUDE.md\n\n`;
  text += `**Action:** ${claudeMdResult.action}\n`;
  text += `**Path:** ${claudeMdResult.path}\n\n`;

  if (dryRun) {
    text += `### Preview\n\n\`\`\`markdown\n${section}\n\`\`\`\n\n`;
  }

  text += `## Hooks (settings.local.json)\n\n`;
  text += `**Action:** ${hooksResult.action}\n`;
  text += `**Path:** ${hooksResult.path}\n\n`;

  const hookEvents = Object.keys(hooks);
  text += `**Events configured:** ${hookEvents.join(", ")}\n`;
  text += `- **SessionStart:** Provider status check\n`;
  text += `- **PreToolUse (git commit):** Interactive commit review\n`;
  text += `- **UserPromptSubmit:** Agestra tool suggestion choice\n`;
  text += `- **Stop:** Completion verification checklist\n\n`;

  if (dryRun) {
    text += `### Preview\n\n\`\`\`json\n${JSON.stringify({ hooks }, null, 2)}\n\`\`\`\n\n`;
  }

  if (dryRun) {
    text += `---\n\nRun with \`dry_run: false\` to write these files.\n`;
  }

  return { content: [{ type: "text", text }] };
}

// ── Dispatcher ───────────────────────────────────────────────

export async function handleTool(
  name: string,
  args: unknown,
  deps: ConfigGenToolDeps,
): Promise<McpToolResult> {
  switch (name) {
    case "agestra_generate_config":
      return handleGenerateConfig(args, deps);
    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
}
