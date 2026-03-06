import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTools, handleTool } from "../tools/cli-worker.js";
import { CliWorkerManager, WorkerState } from "@agestra/core";

// Mock CliWorkerManager
vi.mock("@agestra/core", async () => {
  const actual = await vi.importActual("@agestra/core");
  return {
    ...actual,
    CliWorkerManager: vi.fn().mockImplementation(() => ({
      spawn: vi.fn().mockReturnValue({
        workerId: "codex-123-abc",
        provider: "codex",
        state: "RUNNING",
        pid: 12345,
        worktreePath: null,
        worktreeBranch: null,
        startedAt: Date.now(),
        retryCount: 0,
        exitCode: null,
        error: null,
      }),
      getStatus: vi.fn().mockReturnValue({
        workerId: "codex-123-abc",
        provider: "codex",
        state: "RUNNING",
        elapsedSeconds: 30,
        pid: 12345,
        outputTail: "working...",
        worktreeBranch: null,
        retryCount: 0,
      }),
      collect: vi.fn().mockReturnValue({
        workerId: "codex-123-abc",
        state: "COMPLETED",
        exitCode: 0,
        outputFull: "done",
        gitDiff: "",
        filesChanged: ["src/auth.ts"],
        worktreeBranch: null,
      }),
      stop: vi.fn(),
      listAll: vi.fn().mockReturnValue([]),
    })),
  };
});

describe("cli-worker tools", () => {
  let deps: any;
  let mockManager: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockManager = new CliWorkerManager("/project");
    deps = { cliWorkerManager: mockManager };
  });

  describe("getTools", () => {
    it("should export 4 tools", () => {
      const tools = getTools();
      expect(tools).toHaveLength(4);
      const names = tools.map((t: any) => t.name);
      expect(names).toContain("cli_worker_spawn");
      expect(names).toContain("cli_worker_status");
      expect(names).toContain("cli_worker_collect");
      expect(names).toContain("cli_worker_stop");
    });
  });

  describe("cli_worker_spawn", () => {
    it("should call manager.spawn and return result", async () => {
      const result = await handleTool("cli_worker_spawn", {
        provider: "codex",
        task_description: "Refactor auth",
        working_dir: "/project",
      }, deps);

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("codex-123-abc");
      expect(mockManager.spawn).toHaveBeenCalledWith(expect.objectContaining({
        provider: "codex",
        taskDescription: "Refactor auth",
      }));
    });

    it("should return error when spawn throws", async () => {
      mockManager.spawn.mockImplementation(() => { throw new Error("Secret detected"); });
      const result = await handleTool("cli_worker_spawn", {
        provider: "codex",
        task_description: "bad task",
        working_dir: "/project",
      }, deps);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Secret detected");
    });

    it("should return error when manager not initialized", async () => {
      const result = await handleTool("cli_worker_spawn", {
        provider: "codex",
        task_description: "task",
        working_dir: "/project",
      }, {} as any);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not initialized");
    });
  });

  describe("cli_worker_status", () => {
    it("should return status for specific worker", async () => {
      const result = await handleTool("cli_worker_status", {
        worker_id: "codex-123-abc",
      }, deps);

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("RUNNING");
    });

    it("should list all workers when no ID given", async () => {
      const result = await handleTool("cli_worker_status", {}, deps);
      expect(result.isError).toBeFalsy();
    });

    it("should return error when worker not found", async () => {
      mockManager.getStatus.mockReturnValue(undefined);
      const result = await handleTool("cli_worker_status", {
        worker_id: "nonexistent",
      }, deps);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not found");
    });
  });

  describe("cli_worker_collect", () => {
    it("should return collected results", async () => {
      const result = await handleTool("cli_worker_collect", {
        worker_id: "codex-123-abc",
      }, deps);

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("COMPLETED");
    });

    it("should return error when worker not found", async () => {
      mockManager.collect.mockReturnValue(undefined);
      const result = await handleTool("cli_worker_collect", {
        worker_id: "nonexistent",
      }, deps);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not found");
    });
  });

  describe("cli_worker_stop", () => {
    it("should call manager.stop", async () => {
      const result = await handleTool("cli_worker_stop", {
        worker_id: "codex-123-abc",
      }, deps);

      expect(result.isError).toBeFalsy();
      expect(mockManager.stop).toHaveBeenCalledWith("codex-123-abc");
    });
  });

  describe("unknown tool", () => {
    it("should return error for unknown tool name", async () => {
      const result = await handleTool("wrong_name", {}, deps);
      expect(result.isError).toBe(true);
    });
  });
});
