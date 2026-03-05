import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentLoop } from "../agent-loop.js";
import type { AgentLoopConfig } from "../agent-loop.js";
import type { AgentTool } from "../agent-tools.js";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function ollamaResponse(content: string, toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>) {
  return {
    ok: true,
    json: async () => ({
      message: {
        role: "assistant",
        content,
        tool_calls: toolCalls?.map((tc) => ({
          function: { name: tc.name, arguments: tc.arguments },
        })),
      },
    }),
    text: async () => "",
  };
}

function createTestTool(name: string, result: string | (() => string)): AgentTool {
  return {
    name,
    description: `Test tool: ${name}`,
    parameters: { input: { type: "string", description: "input" } },
    execute: vi.fn(async () => (typeof result === "function" ? result() : result)),
  };
}

describe("AgentLoop", () => {
  let config: AgentLoopConfig;

  beforeEach(() => {
    mockFetch.mockReset();
    config = {
      providerHost: "http://localhost:11434",
      model: "llama3",
      baseDir: "/tmp/test-workspace",
      maxIterations: 15,
      timeoutMs: 300_000,
      tools: [
        createTestTool("file_read", "file contents here"),
        createTestTool("file_write", "File written successfully"),
      ],
    };
  });

  describe("single-turn (no tool calls)", () => {
    it("returns the model response directly", async () => {
      mockFetch.mockResolvedValueOnce(ollamaResponse("The answer is 42."));

      const loop = new AgentLoop(config);
      const result = await loop.run("What is 6*7?");

      expect(result.success).toBe(true);
      expect(result.output).toBe("The answer is 42.");
      expect(result.iterations).toBe(1);
      expect(result.toolCalls).toHaveLength(0);
    });
  });

  describe("multi-turn with tool calls", () => {
    it("executes tool calls and feeds results back", async () => {
      // Turn 1: model calls file_read
      mockFetch.mockResolvedValueOnce(
        ollamaResponse("", [{ name: "file_read", arguments: { path: "src/app.ts" } }]),
      );
      // Turn 2: model responds with final answer
      mockFetch.mockResolvedValueOnce(
        ollamaResponse("I read the file. It contains a Node.js app."),
      );

      const loop = new AgentLoop(config);
      const result = await loop.run("Read src/app.ts and describe it");

      expect(result.success).toBe(true);
      expect(result.output).toContain("Node.js app");
      expect(result.iterations).toBe(2);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].toolName).toBe("file_read");
    });

    it("handles multiple sequential tool calls", async () => {
      // Turn 1: file_read
      mockFetch.mockResolvedValueOnce(
        ollamaResponse("", [{ name: "file_read", arguments: { path: "a.ts" } }]),
      );
      // Turn 2: file_write
      mockFetch.mockResolvedValueOnce(
        ollamaResponse("", [{ name: "file_write", arguments: { path: "b.ts", content: "new" } }]),
      );
      // Turn 3: done
      mockFetch.mockResolvedValueOnce(
        ollamaResponse("Done. I read a.ts and wrote b.ts."),
      );

      const loop = new AgentLoop(config);
      const result = await loop.run("Copy logic from a.ts to b.ts");

      expect(result.success).toBe(true);
      expect(result.iterations).toBe(3);
      expect(result.toolCalls).toHaveLength(2);
    });
  });

  describe("max iterations", () => {
    it("stops after maxIterations", async () => {
      config.maxIterations = 3;

      // Every turn calls a tool (never stops)
      mockFetch.mockResolvedValue(
        ollamaResponse("", [{ name: "file_read", arguments: { path: "x.ts" } }]),
      );

      const loop = new AgentLoop(config);
      const result = await loop.run("infinite task");

      expect(result.success).toBe(false);
      expect(result.iterations).toBe(3);
      expect(result.error).toContain("Max iterations");
    });

    it("caps maxIterations at 30", async () => {
      config.maxIterations = 100;
      // Immediate completion
      mockFetch.mockResolvedValueOnce(ollamaResponse("done"));

      const loop = new AgentLoop(config);
      const result = await loop.run("test");

      expect(result.success).toBe(true);
      // The internal max should be 30, not 100
    });
  });

  describe("error handling", () => {
    it("handles Ollama API errors", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      });

      const loop = new AgentLoop(config);
      const result = await loop.run("test");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Ollama API error");
      expect(result.error).toContain("500");
    });

    it("handles network errors", async () => {
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      const loop = new AgentLoop(config);
      const result = await loop.run("test");

      expect(result.success).toBe(false);
      expect(result.error).toContain("ECONNREFUSED");
    });

    it("handles unknown tool names gracefully", async () => {
      mockFetch.mockResolvedValueOnce(
        ollamaResponse("", [{ name: "nonexistent_tool", arguments: {} }]),
      );
      mockFetch.mockResolvedValueOnce(
        ollamaResponse("Sorry, I used the wrong tool."),
      );

      const loop = new AgentLoop(config);
      const result = await loop.run("test");

      expect(result.success).toBe(true);
      expect(result.toolCalls[0].result).toContain("unknown tool");
    });

    it("handles tool execution errors", async () => {
      const errorTool = createTestTool("file_read", "ok");
      (errorTool.execute as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Permission denied"),
      );
      config.tools = [errorTool];

      mockFetch.mockResolvedValueOnce(
        ollamaResponse("", [{ name: "file_read", arguments: { path: "/etc/shadow" } }]),
      );
      mockFetch.mockResolvedValueOnce(
        ollamaResponse("I couldn't read the file."),
      );

      const loop = new AgentLoop(config);
      const result = await loop.run("read /etc/shadow");

      expect(result.success).toBe(true);
      expect(result.toolCalls[0].result).toContain("Permission denied");
    });

    it("handles string arguments from models", async () => {
      // Some models return arguments as JSON string
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{
              function: {
                name: "file_read",
                arguments: '{"path": "test.ts"}',
              },
            }],
          },
        }),
        text: async () => "",
      });
      mockFetch.mockResolvedValueOnce(ollamaResponse("Done."));

      const loop = new AgentLoop(config);
      const result = await loop.run("read test.ts");

      expect(result.success).toBe(true);
      expect(result.toolCalls[0].arguments).toEqual({ path: "test.ts" });
    });
  });

  describe("conversation messages", () => {
    it("sends system prompt, user message, and tool defs", async () => {
      mockFetch.mockResolvedValueOnce(ollamaResponse("response"));

      const loop = new AgentLoop(config);
      await loop.run("my task");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe("llama3");
      expect(body.stream).toBe(false);
      expect(body.messages).toHaveLength(2); // system + user
      expect(body.messages[0].role).toBe("system");
      expect(body.messages[1].role).toBe("user");
      expect(body.messages[1].content).toBe("my task");
      expect(body.tools).toHaveLength(2);
    });

    it("appends tool results to conversation", async () => {
      mockFetch.mockResolvedValueOnce(
        ollamaResponse("", [{ name: "file_read", arguments: { path: "x.ts" } }]),
      );
      mockFetch.mockResolvedValueOnce(ollamaResponse("done"));

      const loop = new AgentLoop(config);
      await loop.run("read x.ts");

      // Second call should have assistant + tool messages
      const body = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(body.messages.length).toBeGreaterThan(2);
      const roles = body.messages.map((m: any) => m.role);
      expect(roles).toContain("tool");
      expect(roles).toContain("assistant");
    });
  });
});
