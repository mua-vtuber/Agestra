import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { TaskDelegation } from "../task-delegation.js";
import { TaskManager } from "@agestra/workspace";
import type { AIProvider, ChatResponse, ProviderCapability, HealthStatus, ChatRequest } from "@agestra/core";

function mockProvider(id: string, response: string): AIProvider {
  return {
    id, type: "mock",
    initialize: async () => {},
    healthCheck: async (): Promise<HealthStatus> => ({ status: "ok" }),
    getCapabilities: (): ProviderCapability => ({
      maxContext: 4096, supportsSystemPrompt: true, supportsFiles: false,
      supportsStreaming: false, supportsJsonOutput: false, supportsToolUse: false,
      strengths: [], models: [],
    }),
    isAvailable: () => true,
    chat: async (req: ChatRequest): Promise<ChatResponse> => ({
      text: response, model: "mock", provider: id,
    }),
  };
}

describe("TaskDelegation", () => {
  let dir: string;
  let taskManager: TaskManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "task-deleg-"));
    taskManager = new TaskManager(dir);
  });

  afterEach(() => { rmSync(dir, { recursive: true }); });

  it("should assign and execute a task", async () => {
    const delegation = new TaskDelegation(taskManager);
    const provider = mockProvider("ollama", "Task completed successfully");

    const taskId = await delegation.assignTask(provider, "Analyze this code", ["src/main.ts"]);
    expect(taskId).toBeTruthy();

    const result = await delegation.executeTask(taskId, provider);
    expect(result).toContain("completed successfully");

    const status = await delegation.getTaskStatus(taskId);
    expect(status).toBe("completed");
  });

  it("should track task status through lifecycle", async () => {
    const delegation = new TaskDelegation(taskManager);
    const provider = mockProvider("gemini", "Done");

    const taskId = await delegation.assignTask(provider, "Review", []);
    expect(await delegation.getTaskStatus(taskId)).toBe("pending");

    await delegation.executeTask(taskId, provider);
    expect(await delegation.getTaskStatus(taskId)).toBe("completed");
  });
});
