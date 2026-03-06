import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock child_process before importing the module
vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "child_process";
import { getTools, handleTool, resetCache } from "../tools/environment.js";

const mockExecFileSync = vi.mocked(execFileSync);

function createMockRegistry(providers: Array<{
  id: string;
  type: string;
  available: boolean;
  models?: Array<{ name: string; sizeGb?: number; strengths: string[] }>;
}>) {
  return {
    getAll: () => providers.map((p) => ({
      id: p.id,
      type: p.type,
      isAvailable: () => p.available,
      getCapabilities: () => ({
        maxContext: 4096,
        supportsSystemPrompt: true,
        supportsFiles: false,
        supportsStreaming: false,
        supportsJsonOutput: false,
        supportsToolUse: false,
        strengths: ["chat"],
        models: (p.models ?? []).map((m) => ({
          name: m.name,
          description: m.name,
          strengths: m.strengths,
          sizeGb: m.sizeGb,
        })),
      }),
    })),
    get: (id: string) => undefined,
    has: (id: string) => false,
  };
}

describe("environment tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCache();
  });

  describe("getTools", () => {
    it("should export environment_check tool", () => {
      const tools = getTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("environment_check");
    });
  });

  describe("handleTool", () => {
    it("should detect available CLI tools via which", async () => {
      mockExecFileSync.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === "which") {
          if (args[0] === "codex") return "/usr/local/bin/codex" as any;
          if (args[0] === "gemini") return "/usr/local/bin/gemini" as any;
          if (args[0] === "tmux") return "/usr/bin/tmux" as any;
          if (args[0] === "git") return "/usr/bin/git" as any;
        }
        if (cmd === "git" && args[0] === "worktree") return "" as any;
        return "" as any;
      }) as any);

      const deps = { registry: createMockRegistry([]) };
      const result = await handleTool("environment_check", {}, deps as any);

      expect(result.isError).toBeFalsy();
      const text = result.content[0].text;
      expect(text).toContain("codex");
      expect(text).toContain("Available");
      expect(text).toContain("team");  // team mode should be available
    });

    it("should handle missing CLI tools gracefully", async () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error("not found");
      });

      const deps = { registry: createMockRegistry([]) };
      const result = await handleTool("environment_check", {}, deps as any);

      expect(result.isError).toBeFalsy();
      const text = result.content[0].text;
      expect(text).toContain("Not found");
      expect(text).not.toContain("team");  // team mode not available without CLI
    });

    it("should include Ollama models with tier classification", async () => {
      mockExecFileSync.mockImplementation(() => { throw new Error("not found"); });

      const deps = {
        registry: createMockRegistry([
          {
            id: "ollama",
            type: "ollama",
            available: true,
            models: [
              { name: "llama3.2:3b", sizeGb: 2.0, strengths: ["chat"] },
              { name: "qwen2.5-coder:14b", sizeGb: 9.2, strengths: ["code_generation"] },
            ],
          },
        ]),
      };

      const result = await handleTool("environment_check", {}, deps as any);
      const text = result.content[0].text;
      expect(text).toContain("llama3.2:3b");
      expect(text).toContain("simple");
      expect(text).toContain("qwen2.5-coder:14b");
      expect(text).toContain("complex");
    });

    it("should use cache on second call", async () => {
      mockExecFileSync.mockImplementation(() => { throw new Error("not found"); });
      const deps = { registry: createMockRegistry([]) };

      await handleTool("environment_check", {}, deps as any);
      vi.clearAllMocks();

      const result = await handleTool("environment_check", {}, deps as any);
      expect(result.isError).toBeFalsy();
      // which should NOT have been called again
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it("should bypass cache with force_refresh", async () => {
      mockExecFileSync.mockImplementation(() => { throw new Error("not found"); });
      const deps = { registry: createMockRegistry([]) };

      await handleTool("environment_check", {}, deps as any);
      vi.clearAllMocks();
      mockExecFileSync.mockImplementation(() => { throw new Error("not found"); });

      await handleTool("environment_check", { force_refresh: true }, deps as any);
      expect(mockExecFileSync).toHaveBeenCalled();
    });

    it("should list available modes based on providers", async () => {
      mockExecFileSync.mockImplementation(() => { throw new Error("not found"); });

      const deps = {
        registry: createMockRegistry([
          { id: "gemini", type: "gemini-cli", available: true },
        ]),
      };

      const result = await handleTool("environment_check", {}, deps as any);
      const text = result.content[0].text;
      expect(text).toContain("claude_only");
      expect(text).toContain("independent");
      expect(text).toContain("debate");
    });

    it("should return error for unknown tool name", async () => {
      const deps = { registry: createMockRegistry([]) };
      const result = await handleTool("wrong_name", {}, deps as any);
      expect(result.isError).toBe(true);
    });
  });
});
