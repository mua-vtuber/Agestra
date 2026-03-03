import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getTools, handleTool, type HealthToolDeps } from "../tools/health.js";
import type {
  AIProvider,
  ChatRequest,
  ChatResponse,
  ProviderCapability,
  HealthStatus,
  ProviderRegistry,
} from "@agestra/core";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ── Mock provider-detector ───────────────────────────────────

vi.mock("../tools/provider-detector.js", () => ({
  detectProviders: vi.fn().mockResolvedValue({ results: [], providers: [] }),
  updateProvidersConfig: vi.fn().mockReturnValue({
    action: "created",
    path: "/mock/providers.config.json",
  }),
  registerDetectedProviders: vi.fn(),
}));

// ── Mock helpers ─────────────────────────────────────────────

function mockProvider(
  id: string,
  opts?: {
    type?: string;
    available?: boolean;
    healthStatus?: HealthStatus;
    strengths?: string[];
    models?: Array<{ name: string; description: string; strengths: string[] }>;
  },
): AIProvider {
  const o = opts || {};
  return {
    id,
    type: o.type || "mock",
    initialize: async () => {},
    healthCheck: async (): Promise<HealthStatus> =>
      o.healthStatus || { status: "ok", message: "Healthy" },
    getCapabilities: (): ProviderCapability => ({
      maxContext: 4096,
      supportsSystemPrompt: true,
      supportsFiles: false,
      supportsStreaming: false,
      supportsJsonOutput: false,
      supportsToolUse: false,
      strengths: o.strengths || [],
      models: o.models || [],
    }),
    isAvailable: () => o.available !== undefined ? o.available : true,
    chat: async (_req: ChatRequest): Promise<ChatResponse> => ({
      text: "response",
      model: "mock-model",
      provider: id,
    }),
  };
}

function mockRegistry(providers: AIProvider[]): ProviderRegistry {
  const map = new Map<string, AIProvider>();
  for (const p of providers) {
    map.set(p.id, p);
  }
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

describe("health tools", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "health-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("getTools", () => {
    it("should return 2 tool definitions", () => {
      const tools = getTools();
      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe("agestra_setup");
      expect(tools[1].name).toBe("agestra_remove");
    });

    it("should have valid inputSchema with output_dir property", () => {
      const tools = getTools();
      expect(tools[0].inputSchema).toBeDefined();
      expect(tools[0].inputSchema.type).toBe("object");
      expect(tools[0].inputSchema.properties).toHaveProperty("output_dir");
      expect(tools[0].description).toBeTruthy();
    });

    it("should have valid inputSchema for agestra_remove", () => {
      const tools = getTools();
      const removeTool = tools[1];
      expect(removeTool.inputSchema.type).toBe("object");
      expect(removeTool.inputSchema.properties).toHaveProperty("output_dir");
      expect(removeTool.inputSchema.properties).toHaveProperty("remove_runtime_data");
      expect(removeTool.inputSchema.properties).toHaveProperty("remove_providers_config");
    });
  });

  describe("agestra_setup", () => {
    it("should report ready status with healthy providers", async () => {
      const deps: HealthToolDeps = {
        registry: mockRegistry([
          mockProvider("gemini", {
            type: "gemini-cli",
            healthStatus: { status: "ok", message: "3 models available" },
            strengths: ["code_review", "analysis"],
            models: [
              { name: "gemini-2.5-pro", description: "Pro", strengths: ["analysis"] },
            ],
          }),
          mockProvider("ollama", {
            type: "ollama",
            healthStatus: { status: "ok", message: "5 models available" },
            strengths: ["chat", "code_generation"],
            models: [
              { name: "llama3", description: "LLM", strengths: ["chat"] },
              { name: "codellama", description: "Code", strengths: ["code_generation"] },
            ],
          }),
        ]),
        workspacePath: "/home/user/project",
      };

      const result = await handleTool("agestra_setup", { output_dir: tempDir }, deps);

      const text = result.content[0].text;
      expect(text).toContain("Agestra Setup Report");
      expect(text).toContain("gemini");
      expect(text).toContain("ollama");
      expect(text).toContain("OK");
      expect(text).toContain("**Total providers:** 2");
      expect(text).toContain("**Available:** 2");
      expect(text).toContain("**Total models:** 3");
      expect(text).toContain("/home/user/project");
      expect(text).toContain("Ready");
    });

    it("should report partial status when some providers fail", async () => {
      const failingProvider = mockProvider("failing", {
        type: "ollama",
        healthStatus: { status: "error", message: "Connection refused" },
      });

      const deps: HealthToolDeps = {
        registry: mockRegistry([
          mockProvider("gemini", {
            healthStatus: { status: "ok", message: "Healthy" },
          }),
          failingProvider,
        ]),
      };

      const result = await handleTool("agestra_setup", { output_dir: tempDir }, deps);

      const text = result.content[0].text;
      expect(text).toContain("ERROR");
      expect(text).toContain("Connection refused");
      expect(text).toContain("Partial");
    });

    it("should report not ready when no providers are registered", async () => {
      const deps: HealthToolDeps = {
        registry: mockRegistry([]),
      };

      const result = await handleTool("agestra_setup", { output_dir: tempDir }, deps);

      const text = result.content[0].text;
      expect(text).toContain("No providers registered");
      expect(text).toContain("Recommendations");
      expect(text).toContain("Ollama");
      expect(text).toContain("Gemini");
      expect(text).toContain("Not Ready");
    });

    it("should report not ready when all providers are unavailable", async () => {
      const deps: HealthToolDeps = {
        registry: mockRegistry([
          mockProvider("ollama", {
            available: false,
            healthStatus: { status: "error", message: "Ollama not running" },
          }),
        ]),
      };

      const result = await handleTool("agestra_setup", { output_dir: tempDir }, deps);

      const text = result.content[0].text;
      expect(text).toContain("UNAVAILABLE");
      expect(text).toContain("**Available:** 0");
      expect(text).toContain("Not Ready");
    });

    it("should handle health check exceptions", async () => {
      const crashingProvider = mockProvider("crashing");
      crashingProvider.healthCheck = async () => {
        throw new Error("Unexpected error");
      };

      const deps: HealthToolDeps = {
        registry: mockRegistry([crashingProvider]),
      };

      const result = await handleTool("agestra_setup", { output_dir: tempDir }, deps);

      const text = result.content[0].text;
      expect(text).toContain("crashing");
      expect(text).toContain("ERROR");
      expect(text).toContain("Unexpected error");
    });

    it("should show workspace path when configured", async () => {
      const deps: HealthToolDeps = {
        registry: mockRegistry([]),
        workspacePath: "/my/workspace",
      };

      const result = await handleTool("agestra_setup", { output_dir: tempDir }, deps);
      expect(result.content[0].text).toContain("/my/workspace");
    });

    it("should show not configured when no workspace path", async () => {
      const deps: HealthToolDeps = {
        registry: mockRegistry([]),
      };

      const result = await handleTool("agestra_setup", { output_dir: tempDir }, deps);
      expect(result.content[0].text).toContain("not configured");
    });

    it("should aggregate strengths from all available providers", async () => {
      const deps: HealthToolDeps = {
        registry: mockRegistry([
          mockProvider("a", { strengths: ["code_review", "analysis"] }),
          mockProvider("b", { strengths: ["analysis", "chat"] }),
        ]),
      };

      const result = await handleTool("agestra_setup", { output_dir: tempDir }, deps);

      const text = result.content[0].text;
      expect(text).toContain("code_review");
      expect(text).toContain("analysis");
      expect(text).toContain("chat");
    });

    it("should show Ollama model details with size tiers", async () => {
      const deps: HealthToolDeps = {
        registry: mockRegistry([
          mockProvider("ollama", {
            type: "ollama",
            models: [
              { name: "phi3", description: "Ollama model (2GB)", strengths: ["fast"] },
              { name: "llama3", description: "Ollama model (5GB)", strengths: ["chat"] },
              { name: "codellama", description: "Ollama model (14GB)", strengths: ["code"] },
              { name: "mixtral", description: "Ollama model (26GB)", strengths: ["analysis"] },
            ],
          }),
        ]),
      };

      const result = await handleTool("agestra_setup", { output_dir: tempDir }, deps);

      const text = result.content[0].text;
      expect(text).toContain("Ollama Model Details");
      expect(text).toContain("simple (~1-3B params)");
      expect(text).toContain("moderate (~3-7B params)");
      expect(text).toContain("complex (~7-14B params)");
      expect(text).toContain("advanced (~14B+ params)");
    });

    // ── Config Generation ──────────────────────────────────

    it("should generate CLAUDE.md in output_dir", async () => {
      const deps: HealthToolDeps = {
        registry: mockRegistry([
          mockProvider("gemini", { type: "gemini-cli" }),
        ]),
      };

      const result = await handleTool("agestra_setup", { output_dir: tempDir }, deps);

      const text = result.content[0].text;
      expect(text).toContain("Generated Configuration");
      expect(text).toContain("CLAUDE.md");

      const claudeMd = join(tempDir, "CLAUDE.md");
      expect(existsSync(claudeMd)).toBe(true);
      const content = readFileSync(claudeMd, "utf-8");
      expect(content).toContain("agestra");
      expect(content).toContain("BEGIN");
      expect(content).toContain("END");
    });

    it("should generate hooks in .claude/settings.local.json", async () => {
      const deps: HealthToolDeps = {
        registry: mockRegistry([]),
      };

      const result = await handleTool("agestra_setup", { output_dir: tempDir }, deps);

      const text = result.content[0].text;
      expect(text).toContain("Hooks");
      expect(text).toContain("SessionStart");
      expect(text).toContain("PreToolUse");
      expect(text).toContain("Stop");

      const settingsPath = join(tempDir, ".claude", "settings.local.json");
      expect(existsSync(settingsPath)).toBe(true);
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      expect(settings.hooks).toBeDefined();
      expect(settings.hooks.SessionStart).toBeDefined();
      expect(settings.hooks.PreToolUse).toBeDefined();
      expect(settings.hooks.Stop).toBeDefined();
    });

    it("should report file actions in output", async () => {
      const deps: HealthToolDeps = {
        registry: mockRegistry([]),
      };

      const result = await handleTool("agestra_setup", { output_dir: tempDir }, deps);

      const text = result.content[0].text;
      // First run creates both files
      expect(text).toContain("created");
      expect(text).toMatch(/CLAUDE\.md.*created/);
      expect(text).toMatch(/Hooks.*created/);
    });

    it("should report providers.config.json in generated configuration", async () => {
      const deps: HealthToolDeps = {
        registry: mockRegistry([]),
      };

      const result = await handleTool("agestra_setup", { output_dir: tempDir }, deps);

      const text = result.content[0].text;
      expect(text).toContain("providers.config.json");
      expect(text).toContain("Detected Providers");
    });
  });

  describe("agestra_remove", () => {
    it("should remove CLAUDE.md section and hooks created by setup", async () => {
      const deps: HealthToolDeps = {
        registry: mockRegistry([mockProvider("gemini", { type: "gemini-cli" })]),
      };

      // First, run setup to create files
      await handleTool("agestra_setup", { output_dir: tempDir }, deps);

      // Verify files were created
      expect(existsSync(join(tempDir, "CLAUDE.md"))).toBe(true);
      expect(existsSync(join(tempDir, ".claude", "settings.local.json"))).toBe(true);

      // Now run remove
      const result = await handleTool("agestra_remove", { output_dir: tempDir }, deps);

      const text = result.content[0].text;
      expect(text).toContain("Agestra Remove Report");
      expect(text).toContain("Removed");
      expect(text).toContain("CLAUDE.md");
      expect(text).toContain("Events cleared");
    });

    it("should remove providers.config.json by default", async () => {
      // Create a providers.config.json
      writeFileSync(join(tempDir, "providers.config.json"), JSON.stringify({ providers: [] }));

      const deps: HealthToolDeps = { registry: mockRegistry([]) };
      const result = await handleTool("agestra_remove", { output_dir: tempDir }, deps);

      const text = result.content[0].text;
      expect(text).toContain("providers.config.json");
      expect(text).toContain("Removed");
      expect(existsSync(join(tempDir, "providers.config.json"))).toBe(false);
    });

    it("should skip providers.config.json when remove_providers_config is false", async () => {
      writeFileSync(join(tempDir, "providers.config.json"), JSON.stringify({ providers: [] }));

      const deps: HealthToolDeps = { registry: mockRegistry([]) };
      const result = await handleTool("agestra_remove", {
        output_dir: tempDir,
        remove_providers_config: false,
      }, deps);

      const text = result.content[0].text;
      expect(text).toContain("Skipped (remove_providers_config: false)");
      expect(existsSync(join(tempDir, "providers.config.json"))).toBe(true);
    });

    it("should remove .agestra/ runtime data when requested", async () => {
      const runtimeDir = join(tempDir, ".agestra");
      mkdirSync(join(runtimeDir, "sessions"), { recursive: true });
      writeFileSync(join(runtimeDir, "sessions", "test.json"), "{}");

      const deps: HealthToolDeps = { registry: mockRegistry([]) };
      const result = await handleTool("agestra_remove", {
        output_dir: tempDir,
        remove_runtime_data: true,
        remove_providers_config: false,
      }, deps);

      const text = result.content[0].text;
      expect(text).toContain("Removed");
      expect(existsSync(runtimeDir)).toBe(false);
    });

    it("should skip .agestra/ by default", async () => {
      const runtimeDir = join(tempDir, ".agestra");
      mkdirSync(runtimeDir, { recursive: true });

      const deps: HealthToolDeps = { registry: mockRegistry([]) };
      const result = await handleTool("agestra_remove", {
        output_dir: tempDir,
        remove_providers_config: false,
      }, deps);

      const text = result.content[0].text;
      expect(text).toContain("Skipped (remove_runtime_data: false)");
      expect(existsSync(runtimeDir)).toBe(true);
    });

    it("should handle already-clean directory gracefully", async () => {
      const deps: HealthToolDeps = { registry: mockRegistry([]) };
      const result = await handleTool("agestra_remove", {
        output_dir: tempDir,
        remove_providers_config: false,
      }, deps);

      const text = result.content[0].text;
      expect(text).toMatch(/not found|No file|Nothing to remove/);
      expect(result.isError).toBeUndefined();
    });

    it("should preserve non-agestra content in CLAUDE.md", async () => {
      const claudeMdPath = join(tempDir, "CLAUDE.md");
      const userContent = "# My Project\n\nSome user content.\n";
      const agestraSection = "<!-- [agestra:v4.0.0] BEGIN -->\nAgestra stuff\n<!-- [agestra:v4.0.0] END -->";
      writeFileSync(claudeMdPath, userContent + "\n" + agestraSection + "\n");

      const deps: HealthToolDeps = { registry: mockRegistry([]) };
      await handleTool("agestra_remove", {
        output_dir: tempDir,
        remove_providers_config: false,
      }, deps);

      expect(existsSync(claudeMdPath)).toBe(true);
      const remaining = readFileSync(claudeMdPath, "utf-8");
      expect(remaining).toContain("# My Project");
      expect(remaining).toContain("Some user content");
      expect(remaining).not.toContain("agestra:v4.0.0");
    });

    it("should preserve non-agestra hooks in settings", async () => {
      const settingsDir = join(tempDir, ".claude");
      mkdirSync(settingsDir, { recursive: true });
      const settingsPath = join(settingsDir, "settings.local.json");
      writeFileSync(settingsPath, JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "echo user hook" }] },
            { hooks: [{ type: "command", command: "echo [agestra:v4.0.0] test" }] },
          ],
        },
        otherSetting: true,
      }));

      const deps: HealthToolDeps = { registry: mockRegistry([]) };
      await handleTool("agestra_remove", {
        output_dir: tempDir,
        remove_providers_config: false,
      }, deps);

      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      expect(settings.otherSetting).toBe(true);
      expect(settings.hooks.SessionStart).toHaveLength(1);
      expect(settings.hooks.SessionStart[0].hooks[0].command).toBe("echo user hook");
    });
  });

  describe("handleTool dispatcher", () => {
    it("should return error for unknown tool name", async () => {
      const deps: HealthToolDeps = {
        registry: mockRegistry([]),
      };

      const result = await handleTool("nonexistent_tool", {}, deps);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown tool");
    });
  });
});
