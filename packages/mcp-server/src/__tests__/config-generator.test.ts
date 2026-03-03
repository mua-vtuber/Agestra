import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getTools,
  handleTool,
  generateClaudeMdSection,
  generateHooksConfig,
  updateClaudeMd,
  updateHooks,
  type ConfigGenToolDeps,
} from "../tools/config-generator.js";
import type {
  AIProvider,
  ChatRequest,
  ChatResponse,
  ProviderCapability,
  HealthStatus,
  ProviderRegistry,
} from "@agestra/core";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ── Mock helpers ─────────────────────────────────────────────

function mockProvider(
  id: string,
  type: string,
  opts: { models?: Array<{ name: string; description: string; strengths: string[] }>; available?: boolean } = {},
): AIProvider {
  return {
    id,
    type,
    initialize: async () => {},
    healthCheck: async (): Promise<HealthStatus> => ({ status: "ok" }),
    getCapabilities: (): ProviderCapability => ({
      maxContext: 4096,
      supportsSystemPrompt: true,
      supportsFiles: false,
      supportsStreaming: false,
      supportsJsonOutput: false,
      supportsToolUse: false,
      strengths: [],
      models: opts.models || [],
    }),
    isAvailable: () => opts.available ?? true,
    chat: async (_req: ChatRequest): Promise<ChatResponse> => ({
      text: "mock",
      model: "mock",
      provider: id,
    }),
  };
}

function mockRegistry(providers: AIProvider[]): ProviderRegistry {
  const map = new Map<string, AIProvider>();
  for (const p of providers) map.set(p.id, p);
  return {
    register: vi.fn(),
    get: (id: string) => {
      const p = map.get(id);
      if (!p) throw new Error(`Provider not found: ${id}`);
      return p;
    },
    getAll: () => [...map.values()],
    getAvailable: () => [...map.values()].filter((p) => p.isAvailable()),
    getByCapability: () => [],
    has: (id: string) => map.has(id),
  } as unknown as ProviderRegistry;
}

// ── Tests ────────────────────────────────────────────────────

describe("config-generator tools", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "config-gen-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("getTools", () => {
    it("should return 1 tool definition", () => {
      const tools = getTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("agestra_generate_config");
    });

    it("should have valid inputSchema", () => {
      const tools = getTools();
      expect(tools[0].inputSchema.type).toBe("object");
      expect(tools[0].description).toBeTruthy();
    });
  });

  describe("generateClaudeMdSection", () => {
    it("should include version markers", () => {
      const registry = mockRegistry([]);
      const section = generateClaudeMdSection(registry);

      expect(section).toContain("<!-- [agestra:v4.0.0] BEGIN -->");
      expect(section).toContain("<!-- [agestra:v4.0.0] END -->");
    });

    it("should show no providers message when empty", () => {
      const registry = mockRegistry([]);
      const section = generateClaudeMdSection(registry);

      expect(section).toContain("No providers configured");
      expect(section).toContain("agestra_setup");
    });

    it("should list providers with status", () => {
      const registry = mockRegistry([
        mockProvider("ollama", "ollama", { available: true }),
        mockProvider("gemini", "gemini-cli", { available: true }),
      ]);
      const section = generateClaudeMdSection(registry);

      expect(section).toContain("**ollama** (ollama) — Active");
      expect(section).toContain("**gemini** (gemini-cli) — Active");
    });

    it("should show unavailable provider status", () => {
      const registry = mockRegistry([
        mockProvider("ollama", "ollama", { available: false }),
      ]);
      const section = generateClaudeMdSection(registry);

      expect(section).toContain("**ollama** (ollama) — Unavailable");
    });

    it("should show Ollama model details with parameter estimates", () => {
      const registry = mockRegistry([
        mockProvider("ollama", "ollama", {
          models: [
            { name: "qwen2.5-coder:14b", description: "Ollama model (8GB)", strengths: ["code_review", "code_generation"] },
            { name: "llama3:8b", description: "Ollama model (4GB)", strengths: ["chat"] },
            { name: "phi3:mini", description: "Ollama model (2GB)", strengths: ["chat"] },
          ],
        }),
      ]);
      const section = generateClaudeMdSection(registry);

      expect(section).toContain("qwen2.5-coder:14b");
      expect(section).toContain("(~7-14B params)");
      expect(section).toContain("llama3:8b");
      expect(section).toContain("(~3-7B params)");
      expect(section).toContain("phi3:mini");
      expect(section).toContain("(~1-3B params)");
      expect(section).toContain("[code_review, code_generation]");
    });

    it("should include capability guidelines", () => {
      const registry = mockRegistry([]);
      const section = generateClaudeMdSection(registry);

      expect(section).toContain("Provider Capability Guidelines");
      expect(section).toContain("Judge model capability by parameter count");
      expect(section).toContain("< 3GB");
      expect(section).toContain("> 20GB");
    });

    it("should include 429 error handling", () => {
      const registry = mockRegistry([]);
      const section = generateClaudeMdSection(registry);

      expect(section).toContain("429 Rate Limit");
      expect(section).toContain("Deactivate");
      expect(section).toContain("Do NOT wait for rate limit reset");
    });

    it("should include completion verification criteria", () => {
      const registry = mockRegistry([]);
      const section = generateClaudeMdSection(registry);

      expect(section).toContain("Completion Verification");
      expect(section).toContain("Spec compliance");
      expect(section).toContain("System integration");
      expect(section).toContain("Accessibility");
      expect(section).toContain("Tests");
    });

    it("should include workflow recommendations", () => {
      const registry = mockRegistry([]);
      const section = generateClaudeMdSection(registry);

      expect(section).toContain("agent_debate_start");
      expect(section).toContain("agent_dispatch");
      expect(section).toContain("agent_cross_validate");
      expect(section).toContain("memory_dead_ends");
    });

    it("should include memory system info", () => {
      const registry = mockRegistry([]);
      const section = generateClaudeMdSection(registry);

      expect(section).toContain("Memory System");
      expect(section).toContain("dead_end");
      expect(section).toContain("memory_store");
    });

    it("should include auto-routing guidelines", () => {
      const registry = mockRegistry([]);
      const section = generateClaudeMdSection(registry);

      expect(section).toContain("Auto-Routing Guidelines");
      expect(section).toContain("Simple tasks");
      expect(section).toContain("Ollama local model preferred");
      expect(section).toContain("Cloud providers");
      expect(section).toContain("No providers available");
    });

    it("should include AGESTRA_SUGGESTION hook-triggered choice instructions", () => {
      const registry = mockRegistry([]);
      const section = generateClaudeMdSection(registry);

      expect(section).toContain("AGESTRA_SUGGESTION");
      expect(section).toContain("Hook-triggered choice");
      expect(section).toContain("Claude Code handles it alone");
      expect(section).toContain("Multi-AI analysis");
    });

    it("should include manual suggestion fallback", () => {
      const registry = mockRegistry([]);
      const section = generateClaudeMdSection(registry);

      expect(section).toContain("Manual suggestion");
      expect(section).toContain("Suggest once");
    });
  });

  describe("generateHooksConfig", () => {
    it("should generate SessionStart hook in new matcher format", () => {
      const hooks = generateHooksConfig();

      expect(hooks.SessionStart).toHaveLength(1);
      const entry = hooks.SessionStart[0] as any;
      expect(entry.matcher).toBe("startup");
      expect(entry.hooks).toHaveLength(1);
      expect(entry.hooks[0].type).toBe("command");
      expect(entry.hooks[0].command).toContain("[agestra:v4.0.0]");
    });

    it("should generate PreToolUse Bash hook reading from stdin", () => {
      const hooks = generateHooksConfig();

      expect(hooks.PreToolUse).toHaveLength(1);
      const entry = hooks.PreToolUse[0] as any;
      expect(entry.matcher).toBe("Bash");
      expect(entry.hooks).toHaveLength(1);
      expect(entry.hooks[0].type).toBe("command");
      expect(entry.hooks[0].command).toContain("[agestra:v4.0.0]");
      expect(entry.hooks[0].command).toContain("git commit");
      // Must read from stdin, not $TOOL_INPUT
      expect(entry.hooks[0].command).toContain("INPUT=$(cat)");
      expect(entry.hooks[0].command).not.toContain("$TOOL_INPUT");
    });

    it("should generate Stop hook with evaluation question format", () => {
      const hooks = generateHooksConfig();

      expect(hooks.Stop).toHaveLength(1);
      const entry = hooks.Stop[0] as any;
      expect(entry.hooks).toHaveLength(1);
      expect(entry.hooks[0].type).toBe("prompt");
      expect(entry.hooks[0].prompt).toContain("[agestra:v4.0.0]");
      // Must include evaluation format for proper prompt hook responses
      expect(entry.hooks[0].prompt).toContain("$ARGUMENTS");
      expect(entry.hooks[0].prompt).toContain("stop_hook_active");
      expect(entry.hooks[0].prompt).toContain('{"ok": true}');
    });

    it("should generate UserPromptSubmit hook with keyword detection", () => {
      const hooks = generateHooksConfig();

      expect(hooks.UserPromptSubmit).toBeDefined();
      expect(hooks.UserPromptSubmit).toHaveLength(1);
      const entry = hooks.UserPromptSubmit[0] as any;
      expect(entry.hooks).toHaveLength(1);
      expect(entry.hooks[0].type).toBe("command");
      const cmd = entry.hooks[0].command;
      // Must read from stdin
      expect(cmd).toContain("INPUT=$(cat)");
      // Must include multilingual keywords
      expect(cmd).toContain("리뷰");
      expect(cmd).toContain("review");
      expect(cmd).toContain("レビュー");
      // Must output AGESTRA_SUGGESTION marker
      expect(cmd).toContain("AGESTRA_SUGGESTION");
      expect(cmd).toContain("[agestra:v4.0.0]");
    });
  });

  describe("updateClaudeMd", () => {
    it("should create new CLAUDE.md when it does not exist", () => {
      const section = "<!-- [agestra:v4.0.0] BEGIN -->\nTest\n<!-- [agestra:v4.0.0] END -->";
      const result = updateClaudeMd(tmpDir, section, false);

      expect(result.action).toBe("created");
      const content = readFileSync(join(tmpDir, "CLAUDE.md"), "utf-8");
      expect(content).toContain("<!-- [agestra:v4.0.0] BEGIN -->");
      expect(content).toContain("Test");
    });

    it("should append to existing CLAUDE.md without markers", () => {
      writeFileSync(join(tmpDir, "CLAUDE.md"), "# My Project\n\nExisting content.", "utf-8");

      const section = "<!-- [agestra:v4.0.0] BEGIN -->\nNew section\n<!-- [agestra:v4.0.0] END -->";
      const result = updateClaudeMd(tmpDir, section, false);

      expect(result.action).toBe("appended");
      const content = readFileSync(join(tmpDir, "CLAUDE.md"), "utf-8");
      expect(content).toContain("# My Project");
      expect(content).toContain("Existing content.");
      expect(content).toContain("New section");
    });

    it("should replace existing section with matching markers", () => {
      const existing =
        "# My Project\n\n" +
        "<!-- [agestra:v3.0.0] BEGIN -->\nOld content\n<!-- [agestra:v3.0.0] END -->\n\n" +
        "## Other Section\n";
      writeFileSync(join(tmpDir, "CLAUDE.md"), existing, "utf-8");

      const section = "<!-- [agestra:v4.0.0] BEGIN -->\nUpdated content\n<!-- [agestra:v4.0.0] END -->";
      const result = updateClaudeMd(tmpDir, section, false);

      expect(result.action).toBe("replaced");
      const content = readFileSync(join(tmpDir, "CLAUDE.md"), "utf-8");
      expect(content).toContain("# My Project");
      expect(content).toContain("Updated content");
      expect(content).not.toContain("Old content");
      expect(content).toContain("## Other Section");
    });

    it("should not write in dry_run mode", () => {
      const section = "<!-- [agestra:v4.0.0] BEGIN -->\nTest\n<!-- [agestra:v4.0.0] END -->";
      const result = updateClaudeMd(tmpDir, section, true);

      expect(result.action).toBe("created");
      // File should NOT exist
      expect(() => readFileSync(join(tmpDir, "CLAUDE.md"), "utf-8")).toThrow();
    });
  });

  describe("updateHooks", () => {
    it("should create new settings.local.json with hooks", () => {
      const hooks = {
        SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "[agestra:v4.0.0] test" }] }],
      };
      const result = updateHooks(tmpDir, hooks, false);

      expect(result.action).toBe("created");
      const content = JSON.parse(readFileSync(result.path, "utf-8"));
      expect(content.hooks.SessionStart).toHaveLength(1);
      expect(content.hooks.SessionStart[0].hooks[0].command).toContain("agestra");
    });

    it("should merge with existing settings preserving other keys", () => {
      const settingsDir = join(tmpDir, ".claude");
      mkdirSync(settingsDir, { recursive: true });
      writeFileSync(
        join(settingsDir, "settings.local.json"),
        JSON.stringify({ otherSetting: true, hooks: {} }, null, 2),
        "utf-8",
      );

      const hooks = {
        SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "[agestra:v4.0.0] test" }] }],
      };
      const result = updateHooks(tmpDir, hooks, false);

      expect(result.action).toBe("updated");
      const content = JSON.parse(readFileSync(result.path, "utf-8"));
      expect(content.otherSetting).toBe(true);
      expect(content.hooks.SessionStart).toHaveLength(1);
    });

    it("should replace old version hooks (new format) but keep non-agestra hooks", () => {
      const settingsDir = join(tmpDir, ".claude");
      mkdirSync(settingsDir, { recursive: true });
      writeFileSync(
        join(settingsDir, "settings.local.json"),
        JSON.stringify({
          hooks: {
            SessionStart: [
              { matcher: "startup", hooks: [{ type: "command", command: "[agestra:v3.0.0] old hook" }] },
              { matcher: "startup", hooks: [{ type: "command", command: "echo user hook" }] },
            ],
          },
        }, null, 2),
        "utf-8",
      );

      const hooks = {
        SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "[agestra:v4.0.0] new hook" }] }],
      };
      const result = updateHooks(tmpDir, hooks, false);

      const content = JSON.parse(readFileSync(result.path, "utf-8"));
      expect(content.hooks.SessionStart).toHaveLength(2);
      // User hook preserved
      expect(content.hooks.SessionStart[0].hooks[0].command).toBe("echo user hook");
      // New agestra hook added
      expect(content.hooks.SessionStart[1].hooks[0].command).toContain("v4.0.0");
    });

    it("should replace old version hooks (old flat format) and keep non-agestra hooks", () => {
      const settingsDir = join(tmpDir, ".claude");
      mkdirSync(settingsDir, { recursive: true });
      writeFileSync(
        join(settingsDir, "settings.local.json"),
        JSON.stringify({
          hooks: {
            SessionStart: [
              { type: "command", command: "[agestra:v3.0.0] old flat hook" },
              { type: "command", command: "echo user hook" },
            ],
          },
        }, null, 2),
        "utf-8",
      );

      const hooks = {
        SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "[agestra:v4.0.0] new hook" }] }],
      };
      const result = updateHooks(tmpDir, hooks, false);

      const content = JSON.parse(readFileSync(result.path, "utf-8"));
      expect(content.hooks.SessionStart).toHaveLength(2);
      // Old flat user hook preserved
      expect(content.hooks.SessionStart[0].command).toBe("echo user hook");
      // New agestra hook added
      expect(content.hooks.SessionStart[1].hooks[0].command).toContain("v4.0.0");
    });

    it("should not write in dry_run mode", () => {
      const hooks = {
        SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "[agestra:v4.0.0] test" }] }],
      };
      const result = updateHooks(tmpDir, hooks, true);

      expect(result.action).toBe("created");
      expect(() => readFileSync(result.path, "utf-8")).toThrow();
    });
  });

  describe("handleTool agestra_generate_config", () => {
    it("should return dry_run preview with CLAUDE.md and hooks", async () => {
      const deps: ConfigGenToolDeps = {
        registry: mockRegistry([
          mockProvider("ollama", "ollama", {
            models: [{ name: "llama3", description: "Ollama model (4GB)", strengths: ["chat"] }],
          }),
          mockProvider("gemini", "gemini-cli"),
        ]),
      };

      const result = await handleTool(
        "agestra_generate_config",
        { output_dir: tmpDir, dry_run: true },
        deps,
      );

      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      expect(text).toContain("Configuration Generated");
      expect(text).toContain("Dry run (preview only)");
      expect(text).toContain("agestra v4.0.0");
      expect(text).toContain("CLAUDE.md");
      expect(text).toContain("Hooks");
      expect(text).toContain("Preview");
      // Should contain the CLAUDE.md content in the preview
      expect(text).toContain("ollama");
      expect(text).toContain("llama3");
    });

    it("should write files when dry_run=false", async () => {
      const deps: ConfigGenToolDeps = {
        registry: mockRegistry([mockProvider("ollama", "ollama")]),
      };

      const result = await handleTool(
        "agestra_generate_config",
        { output_dir: tmpDir, dry_run: false },
        deps,
      );

      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      expect(text).toContain("Written to disk");

      // CLAUDE.md should exist
      const claudeMd = readFileSync(join(tmpDir, "CLAUDE.md"), "utf-8");
      expect(claudeMd).toContain("<!-- [agestra:v4.0.0] BEGIN -->");

      // settings.local.json should exist
      const settings = JSON.parse(
        readFileSync(join(tmpDir, ".claude", "settings.local.json"), "utf-8"),
      );
      expect(settings.hooks).toBeDefined();
      expect(settings.hooks.SessionStart).toBeDefined();
      expect(settings.hooks.PreToolUse).toBeDefined();
      expect(settings.hooks.UserPromptSubmit).toBeDefined();
      expect(settings.hooks.Stop).toBeDefined();
    });

    it("should default to dry_run=true", async () => {
      const deps: ConfigGenToolDeps = {
        registry: mockRegistry([]),
      };

      const result = await handleTool(
        "agestra_generate_config",
        { output_dir: tmpDir },
        deps,
      );

      const text = result.content[0].text;
      expect(text).toContain("Dry run (preview only)");
    });

    it("should return error for unknown tool", async () => {
      const deps: ConfigGenToolDeps = {
        registry: mockRegistry([]),
      };

      const result = await handleTool("unknown_tool", {}, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown tool");
    });
  });
});
