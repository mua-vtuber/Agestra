import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTools, handleTool, type JobToolDeps } from "../tools/jobs.js";
import type { JobManager, JobResult } from "@agestra/core";
import type { MemoryFacade } from "@agestra/memory";

function createMockJobManager(): JobManager {
  return {
    submit: vi.fn().mockReturnValue("gemini-1234567890-abc123"),
    getStatus: vi.fn().mockReturnValue(null),
    getResult: vi.fn().mockReturnValue(null),
    listJobs: vi.fn().mockReturnValue([]),
    cancel: vi.fn().mockReturnValue(false),
  } as unknown as JobManager;
}

function createMockMemoryFacade(): MemoryFacade {
  return {
    store: vi.fn(),
    search: vi.fn().mockResolvedValue([]),
  } as unknown as MemoryFacade;
}

describe("jobs tools", () => {
  let deps: JobToolDeps;
  let mockJobManager: ReturnType<typeof createMockJobManager>;
  let mockMemory: MemoryFacade;

  beforeEach(() => {
    mockJobManager = createMockJobManager();
    mockMemory = createMockMemoryFacade();
    deps = { jobManager: mockJobManager, memoryFacade: mockMemory };
  });

  describe("getTools", () => {
    it("should return 2 tools", () => {
      const tools = getTools();
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.name)).toEqual(["cli_job_submit", "cli_job_status"]);
    });
  });

  describe("cli_job_submit", () => {
    it("should submit a job and return job_id", async () => {
      const result = await handleTool("cli_job_submit", {
        provider: "gemini",
        prompt: "Analyze this code",
      }, deps);

      expect(mockJobManager.submit).toHaveBeenCalledWith({
        provider: "gemini",
        prompt: "Analyze this code",
        timeout: undefined,
      });
      expect(result.content[0].text).toContain("Job submitted");
      expect(result.content[0].text).toContain("gemini-1234567890-abc123");
      expect(result.isError).toBeUndefined();
    });

    it("should pass timeout option", async () => {
      await handleTool("cli_job_submit", {
        provider: "codex",
        prompt: "Fix bug",
        timeout: 60000,
      }, deps);

      expect(mockJobManager.submit).toHaveBeenCalledWith({
        provider: "codex",
        prompt: "Fix bug",
        timeout: 60000,
      });
    });
  });

  describe("cli_job_status", () => {
    it("should return error for unknown job", async () => {
      const result = await handleTool("cli_job_status", {
        job_id: "nonexistent",
      }, deps);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Job not found");
    });

    it("should return status for queued job", async () => {
      vi.mocked(mockJobManager.getResult).mockReturnValue({
        id: "gemini-123-abc",
        state: "queued",
      } as JobResult);

      const result = await handleTool("cli_job_status", {
        job_id: "gemini-123-abc",
      }, deps);

      expect(result.content[0].text).toContain("queued");
      // isError is false for queued state (not an error)
      expect(result.isError).toBe(false);
    });

    it("should return output for completed job", async () => {
      vi.mocked(mockJobManager.getResult).mockReturnValue({
        id: "gemini-123-abc",
        state: "completed",
        exitCode: 0,
        output: "Analysis result here",
      } as JobResult);

      const result = await handleTool("cli_job_status", {
        job_id: "gemini-123-abc",
      }, deps);

      expect(result.content[0].text).toContain("completed");
      expect(result.content[0].text).toContain("Analysis result here");
    });

    it("should flag error state and record dead_end", async () => {
      vi.mocked(mockJobManager.getResult).mockReturnValue({
        id: "gemini-123-abc",
        state: "error",
        exitCode: 1,
        error: "CLI crashed",
      } as JobResult);

      const result = await handleTool("cli_job_status", {
        job_id: "gemini-123-abc",
      }, deps);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("CLI crashed");

      // Should record failure as dead_end in memory
      expect(mockMemory.store).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeType: "dead_end",
          topic: "technical",
        }),
      );
    });
  });
});
