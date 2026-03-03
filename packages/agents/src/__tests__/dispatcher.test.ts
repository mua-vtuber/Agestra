import { describe, it, expect, vi, beforeEach } from "vitest";
import { TaskDispatcher } from "../dispatcher.js";
import type { DispatchConfig } from "../dispatcher.js";
import type { ProviderRegistry, JobManager, AIProvider, ProviderCapability, HealthStatus, ChatRequest, ChatResponse } from "@agestra/core";

function mockProvider(id: string): AIProvider {
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
    chat: async (_req: ChatRequest): Promise<ChatResponse> => ({
      text: `response from ${id}`, model: "mock", provider: id,
    }),
  };
}

function createMockRegistry(): ProviderRegistry {
  const providers = new Map<string, AIProvider>();
  providers.set("gemini", mockProvider("gemini"));
  providers.set("codex", mockProvider("codex"));

  return {
    register: vi.fn(),
    get: (id: string) => {
      const p = providers.get(id);
      if (!p) throw new Error(`Provider not found: ${id}`);
      return p;
    },
    getAll: () => [...providers.values()],
    getAvailable: () => [...providers.values()],
    getByCapability: vi.fn(() => []),
    has: (id: string) => providers.has(id),
    getCapability: vi.fn(),
    getByTier: vi.fn(() => []),
  } as unknown as ProviderRegistry;
}

function createMockJobManager(): JobManager & { _jobs: Map<string, { state: string; output: string }> } {
  const jobs = new Map<string, { state: string; output: string }>();
  let submitCount = 0;

  return {
    _jobs: jobs,
    submit: vi.fn((options: { provider: string; prompt: string }) => {
      const id = `job-${submitCount++}`;
      // Jobs complete immediately in tests
      jobs.set(id, { state: "completed", output: `output for ${options.provider}: ${options.prompt}` });
      return id;
    }),
    getStatus: vi.fn((jobId: string) => {
      const job = jobs.get(jobId);
      if (!job) return null;
      return { id: jobId, state: job.state, provider: "mock" };
    }),
    getResult: vi.fn((jobId: string) => {
      const job = jobs.get(jobId);
      if (!job) return null;
      return { id: jobId, state: job.state, output: job.output };
    }),
    listJobs: vi.fn(() => []),
    cancel: vi.fn(() => true),
  } as unknown as JobManager & { _jobs: Map<string, { state: string; output: string }> };
}

describe("TaskDispatcher", () => {
  let registry: ProviderRegistry;
  let jobManager: ReturnType<typeof createMockJobManager>;
  let dispatcher: TaskDispatcher;

  beforeEach(() => {
    registry = createMockRegistry();
    jobManager = createMockJobManager();
    dispatcher = new TaskDispatcher(registry, jobManager as unknown as JobManager);
  });

  describe("parallel dispatch (no dependencies)", () => {
    it("should dispatch all assignments in parallel", async () => {
      const config: DispatchConfig = {
        assignments: [
          { id: "a1", providerId: "gemini", task: "analyze code" },
          { id: "a2", providerId: "codex", task: "write tests" },
        ],
        mergeStrategy: "concatenate",
      };

      const result = await dispatcher.dispatch(config);

      expect(result.results).toHaveLength(2);
      expect(result.results.find((r) => r.assignmentId === "a1")).toBeDefined();
      expect(result.results.find((r) => r.assignmentId === "a2")).toBeDefined();

      // Both should have been submitted (in the same batch)
      expect(jobManager.submit).toHaveBeenCalledTimes(2);
    });

    it("should auto-generate IDs for assignments without them", async () => {
      const config: DispatchConfig = {
        assignments: [
          { providerId: "gemini", task: "task A" },
          { providerId: "codex", task: "task B" },
        ],
        mergeStrategy: "concatenate",
      };

      const result = await dispatcher.dispatch(config);

      expect(result.results).toHaveLength(2);
      // IDs should be auto-generated and non-empty
      for (const r of result.results) {
        expect(r.assignmentId).toBeTruthy();
        expect(r.assignmentId.length).toBeGreaterThan(0);
      }
    });

    it("should generate full UUID assignment IDs", async () => {
      const config: DispatchConfig = {
        assignments: [
          { providerId: "gemini", task: "task A" },
        ],
        mergeStrategy: "concatenate",
      };

      const result = await dispatcher.dispatch(config);

      expect(result.results[0].assignmentId).toHaveLength(36);
      expect(result.results[0].assignmentId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it("should mark all results as completed", async () => {
      const config: DispatchConfig = {
        assignments: [
          { id: "a1", providerId: "gemini", task: "task" },
          { id: "a2", providerId: "codex", task: "task" },
        ],
        mergeStrategy: "concatenate",
      };

      const result = await dispatcher.dispatch(config);

      for (const r of result.results) {
        expect(r.status).toBe("completed");
      }
    });
  });

  describe("sequential dispatch (with dependencies)", () => {
    it("should respect dependency order", async () => {
      const submitOrder: string[] = [];
      let count = 0;
      (jobManager.submit as ReturnType<typeof vi.fn>).mockImplementation(
        (options: { provider: string; prompt: string }) => {
          submitOrder.push(options.prompt);
          const id = `job-dep-${count++}`;
          jobManager._jobs.set(id, { state: "completed", output: `output: ${options.prompt}` });
          return id;
        },
      );

      const config: DispatchConfig = {
        assignments: [
          { id: "first", providerId: "gemini", task: "step one" },
          { id: "second", providerId: "codex", task: "step two", dependsOn: ["first"] },
        ],
        mergeStrategy: "concatenate",
      };

      const result = await dispatcher.dispatch(config);

      expect(result.results).toHaveLength(2);
      // "step one" must be submitted before "step two"
      expect(submitOrder.indexOf("step one")).toBeLessThan(submitOrder.indexOf("step two"));
    });

    it("should handle multi-level dependencies", async () => {
      const submitOrder: string[] = [];
      let count = 0;
      (jobManager.submit as ReturnType<typeof vi.fn>).mockImplementation(
        (options: { provider: string; prompt: string }) => {
          submitOrder.push(options.prompt);
          const id = `job-dep-${count++}`;
          jobManager._jobs.set(id, { state: "completed", output: `output: ${options.prompt}` });
          return id;
        },
      );

      const config: DispatchConfig = {
        assignments: [
          { id: "a", providerId: "gemini", task: "level 0" },
          { id: "b", providerId: "codex", task: "level 1", dependsOn: ["a"] },
          { id: "c", providerId: "gemini", task: "level 2", dependsOn: ["b"] },
        ],
        mergeStrategy: "concatenate",
      };

      const result = await dispatcher.dispatch(config);

      expect(result.results).toHaveLength(3);
      expect(submitOrder).toEqual(["level 0", "level 1", "level 2"]);
    });

    it("should handle error in jobs", async () => {
      let submitCount = 0;
      (jobManager.submit as ReturnType<typeof vi.fn>).mockImplementation(
        (options: { provider: string; prompt: string }) => {
          const id = `job-err-${submitCount++}`;
          jobManager._jobs.set(id, {
            state: options.prompt === "will fail" ? "error" : "completed",
            output: options.prompt === "will fail" ? "something went wrong" : "ok",
          });
          return id;
        },
      );

      const config: DispatchConfig = {
        assignments: [
          { id: "a1", providerId: "gemini", task: "will fail" },
          { id: "a2", providerId: "codex", task: "will succeed" },
        ],
        mergeStrategy: "concatenate",
      };

      const result = await dispatcher.dispatch(config);

      const errorResult = result.results.find((r) => r.assignmentId === "a1");
      const okResult = result.results.find((r) => r.assignmentId === "a2");
      expect(errorResult?.status).toBe("error");
      expect(okResult?.status).toBe("completed");
    });
  });

  describe("merge strategies", () => {
    it("concatenate: should join outputs with separators", async () => {
      const config: DispatchConfig = {
        assignments: [
          { id: "a1", providerId: "gemini", task: "task A" },
          { id: "a2", providerId: "codex", task: "task B" },
        ],
        mergeStrategy: "concatenate",
      };

      const result = await dispatcher.dispatch(config);

      expect(result.mergedOutput).toBeDefined();
      expect(result.mergedOutput).toContain("---");
      expect(result.mergedOutput).toContain("gemini");
      expect(result.mergedOutput).toContain("codex");
    });

    it("summarize: should fall back to concatenate when no validator", async () => {
      const config: DispatchConfig = {
        assignments: [
          { id: "a1", providerId: "gemini", task: "task" },
        ],
        mergeStrategy: "summarize",
      };

      const result = await dispatcher.dispatch(config);

      expect(result.mergedOutput).toBeDefined();
      expect(result.mergedOutput).toContain("gemini");
    });

    it("summarize: should call validator.chat() when validator is provided", async () => {
      const validator = mockProvider("validator");

      const config: DispatchConfig = {
        assignments: [
          { id: "a1", providerId: "gemini", task: "task" },
        ],
        mergeStrategy: "summarize",
        validator,
      };

      const result = await dispatcher.dispatch(config);

      expect(result.mergedOutput).toBeDefined();
      // The validator returns its chat response as the merged output
      expect(result.mergedOutput).toBe("response from validator");
    });

    it("debate: should concatenate outputs", async () => {
      const config: DispatchConfig = {
        assignments: [
          { id: "a1", providerId: "gemini", task: "argue for X" },
          { id: "a2", providerId: "codex", task: "argue for Y" },
        ],
        mergeStrategy: "debate",
      };

      const result = await dispatcher.dispatch(config);

      expect(result.mergedOutput).toBeDefined();
      expect(result.mergedOutput).toContain("gemini");
      expect(result.mergedOutput).toContain("codex");
    });
  });

  describe("edge cases", () => {
    it("should handle empty assignments", async () => {
      const config: DispatchConfig = {
        assignments: [],
        mergeStrategy: "concatenate",
      };

      const result = await dispatcher.dispatch(config);

      expect(result.results).toHaveLength(0);
      expect(result.mergedOutput).toBeUndefined();
    });

    it("should handle timed_out jobs", async () => {
      let submitCount = 0;
      (jobManager.submit as ReturnType<typeof vi.fn>).mockImplementation(
        (_options: { provider: string; prompt: string }) => {
          const id = `job-to-${submitCount++}`;
          jobManager._jobs.set(id, { state: "timed_out", output: "" });
          return id;
        },
      );

      const config: DispatchConfig = {
        assignments: [{ id: "a1", providerId: "gemini", task: "slow task" }],
        mergeStrategy: "concatenate",
      };

      const result = await dispatcher.dispatch(config);

      expect(result.results[0].status).toBe("timed_out");
    });
  });

  describe("global timeout", () => {
    it("times out long-running dispatch", async () => {
      // Mock a job manager that never completes
      (jobManager.getResult as ReturnType<typeof vi.fn>).mockReturnValue(null);
      let submitCount = 0;
      (jobManager.submit as ReturnType<typeof vi.fn>).mockImplementation(
        (_options: { provider: string; prompt: string }) => {
          return `job-never-${submitCount++}`;
        },
      );

      const config: DispatchConfig = {
        assignments: [
          { id: "a1", providerId: "gemini", task: "long task" },
          { id: "a2", providerId: "codex", task: "another long task" },
        ],
        mergeStrategy: "concatenate",
        timeoutMs: 100,
      };

      const result = await dispatcher.dispatch(config);

      // All assignments should be timed_out
      expect(result.results).toHaveLength(2);
      for (const r of result.results) {
        expect(r.status).toBe("timed_out");
      }
    });
  });

  describe("merge strategies with validator", () => {
    it("summarize merge strategy calls validator.chat()", async () => {
      const validator = mockProvider("validator");
      const chatSpy = vi.spyOn(validator, "chat").mockResolvedValue({
        text: "Unified summary of all results",
        model: "mock",
        provider: "validator",
      });

      const config: DispatchConfig = {
        assignments: [
          { id: "a1", providerId: "gemini", task: "task A" },
        ],
        mergeStrategy: "summarize",
        validator,
      };

      const result = await dispatcher.dispatch(config);

      expect(chatSpy).toHaveBeenCalledTimes(1);
      expect(chatSpy.mock.calls[0][0].prompt).toContain("synthesize and summarize");
      expect(result.mergedOutput).toBe("Unified summary of all results");
    });

    it("debate merge strategy calls validator.chat()", async () => {
      const validator = mockProvider("validator");
      const chatSpy = vi.spyOn(validator, "chat").mockResolvedValue({
        text: "Best approach analysis",
        model: "mock",
        provider: "validator",
      });

      const config: DispatchConfig = {
        assignments: [
          { id: "a1", providerId: "gemini", task: "approach X" },
          { id: "a2", providerId: "codex", task: "approach Y" },
        ],
        mergeStrategy: "debate",
        validator,
      };

      const result = await dispatcher.dispatch(config);

      expect(chatSpy).toHaveBeenCalledTimes(1);
      expect(chatSpy.mock.calls[0][0].prompt).toContain("Compare the following approaches");
      expect(result.mergedOutput).toBe("Best approach analysis");
    });

    it("merge strategy falls back to concatenate when validator fails", async () => {
      const validator = mockProvider("validator");
      vi.spyOn(validator, "chat").mockRejectedValue(new Error("provider down"));

      const config: DispatchConfig = {
        assignments: [
          { id: "a1", providerId: "gemini", task: "task A" },
        ],
        mergeStrategy: "summarize",
        validator,
      };

      const result = await dispatcher.dispatch(config);

      expect(result.mergedOutput).toBeDefined();
      expect(result.mergedOutput).toContain("gemini");
      expect(result.mergedOutput).toContain("a1");
    });
  });
});
