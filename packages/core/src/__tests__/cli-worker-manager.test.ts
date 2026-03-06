import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CliWorkerManager, WorkerState, type WorkerInfo } from "../cli-worker-manager.js";

// Mock all external dependencies
vi.mock("child_process", () => ({
  execFileSync: vi.fn().mockReturnValue(""),
  spawn: vi.fn().mockReturnValue({
    pid: 12345,
    on: vi.fn(),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    unref: vi.fn(),
  }),
}));

vi.mock("fs", async () => {
  const actual = await vi.importActual("fs");
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn().mockReturnValue("{}"),
  };
});

import { spawn } from "child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";

const mockSpawn = vi.mocked(spawn);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockMkdirSync = vi.mocked(mkdirSync);

describe("CliWorkerManager", () => {
  let manager: CliWorkerManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    manager = new CliWorkerManager("/project");
  });

  describe("spawn", () => {
    it("should create a worker and return WorkerInfo", () => {
      const info = manager.spawn({
        provider: "codex",
        taskDescription: "Refactor auth",
        workingDir: "/project",
      });

      expect(info.provider).toBe("codex");
      expect(info.state).toBe(WorkerState.RUNNING);
      expect(info.pid).toBe(12345);
      expect(info.workerId).toBeDefined();
    });

    it("should write task manifest to disk", () => {
      manager.spawn({
        provider: "codex",
        taskDescription: "Do work",
        workingDir: "/project",
      });

      expect(mockWriteFileSync).toHaveBeenCalled();
      const writeCall = mockWriteFileSync.mock.calls.find(
        (c) => String(c[0]).includes("task-manifest.json"),
      );
      expect(writeCall).toBeDefined();
    });

    it("should reject task with embedded secrets", () => {
      expect(() => {
        manager.spawn({
          provider: "codex",
          taskDescription: 'Use password = "hunter2" to connect',
          workingDir: "/project",
        });
      }).toThrow(/secret/i);
    });

    it("should spawn process with array-based args (no string interpolation)", () => {
      manager.spawn({
        provider: "codex",
        taskDescription: "Task",
        workingDir: "/project",
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ cwd: expect.any(String) }),
      );
      // Verify args are an array, not a string
      const spawnArgs = mockSpawn.mock.calls[0][1];
      expect(Array.isArray(spawnArgs)).toBe(true);
    });
  });

  describe("getStatus", () => {
    it("should return worker status", () => {
      const info = manager.spawn({
        provider: "codex",
        taskDescription: "Task",
        workingDir: "/project",
      });

      const status = manager.getStatus(info.workerId);
      expect(status).toBeDefined();
      expect(status!.state).toBe(WorkerState.RUNNING);
      expect(status!.provider).toBe("codex");
    });

    it("should return undefined for unknown worker", () => {
      expect(manager.getStatus("nonexistent")).toBeUndefined();
    });
  });

  describe("stop", () => {
    it("should transition to CANCELLING state", () => {
      const info = manager.spawn({
        provider: "codex",
        taskDescription: "Task",
        workingDir: "/project",
      });

      manager.stop(info.workerId);
      const status = manager.getStatus(info.workerId);
      expect(status!.state).toBe(WorkerState.CANCELLING);
    });

    it("should be no-op for unknown worker", () => {
      expect(() => manager.stop("nonexistent")).not.toThrow();
    });
  });

  describe("listAll", () => {
    it("should list all workers", () => {
      manager.spawn({ provider: "codex", taskDescription: "A", workingDir: "/p" });
      manager.spawn({ provider: "gemini", taskDescription: "B", workingDir: "/p" });

      const all = manager.listAll();
      expect(all).toHaveLength(2);
    });
  });

  describe("WorkerState enum", () => {
    it("should have all 8 FSM states", () => {
      expect(WorkerState.SPAWNING).toBe("SPAWNING");
      expect(WorkerState.RUNNING).toBe("RUNNING");
      expect(WorkerState.COLLECTING).toBe("COLLECTING");
      expect(WorkerState.COMPLETED).toBe("COMPLETED");
      expect(WorkerState.FAILED).toBe("FAILED");
      expect(WorkerState.CANCELLING).toBe("CANCELLING");
      expect(WorkerState.CANCELLED).toBe("CANCELLED");
      expect(WorkerState.TIMEOUT).toBe("TIMEOUT");
    });
  });
});
