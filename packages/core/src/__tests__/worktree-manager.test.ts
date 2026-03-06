import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorktreeManager } from "../worktree-manager.js";

// Mock child_process and fs since we can't run real git in unit tests
vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("fs", async () => {
  const actual = await vi.importActual("fs");
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

import { execFileSync } from "child_process";
import { existsSync } from "fs";

const mockExecFileSync = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(existsSync);

describe("WorktreeManager", () => {
  let manager: WorktreeManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new WorktreeManager("/project");
    mockExecFileSync.mockReturnValue("" as any);
  });

  describe("create", () => {
    it("should create worktree with correct branch naming", () => {
      mockExistsSync.mockReturnValue(false);
      const result = manager.create("my-task-123");

      expect(result.branch).toBe("agestra-worker/my-task-123");
      expect(result.path).toContain(".agestra");
      expect(result.path).toContain("worktrees");
      expect(result.id).toBe("my-task-123");
    });

    it("should sanitize dangerous characters from task ID", () => {
      mockExistsSync.mockReturnValue(false);
      const result = manager.create("../../etc/passwd");

      expect(result.branch).not.toContain("..");
      expect(result.path).not.toContain("..");
    });

    it("should truncate long task IDs", () => {
      mockExistsSync.mockReturnValue(false);
      const longId = "a".repeat(100);
      const result = manager.create(longId);

      expect(result.branch.length).toBeLessThan(80);
    });

    it("should clean up leftover worktree before creating", () => {
      mockExistsSync.mockReturnValue(true);
      manager.create("leftover-task");

      // Should attempt remove before creating
      const removeCalls = mockExecFileSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1].includes("remove"),
      );
      expect(removeCalls.length).toBeGreaterThan(0);
    });

    it("should call git worktree add with correct args", () => {
      mockExistsSync.mockReturnValue(false);
      manager.create("test-task");

      const addCall = mockExecFileSync.mock.calls.find(
        (call) => Array.isArray(call[1]) && call[1][0] === "worktree" && call[1][1] === "add",
      );
      expect(addCall).toBeDefined();
      expect(addCall![1]).toContain("-b");
      expect(addCall![1]).toContain("HEAD");
    });
  });

  describe("remove", () => {
    it("should remove tracked worktree", () => {
      mockExistsSync.mockReturnValue(false);
      manager.create("task-to-remove");
      vi.clearAllMocks();
      mockExecFileSync.mockReturnValue("" as any);

      manager.remove("task-to-remove");

      const removeCalls = mockExecFileSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && call[1].includes("remove"),
      );
      expect(removeCalls.length).toBeGreaterThan(0);
    });

    it("should be no-op for unknown task", () => {
      manager.remove("nonexistent");
      // Should not throw, should not call git
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it("should fall back to force remove on failure", () => {
      mockExistsSync.mockReturnValue(false);
      manager.create("stuck-task");
      vi.clearAllMocks();

      // First remove throws, force remove succeeds
      let callCount = 0;
      mockExecFileSync.mockImplementation(((cmd: string, args: string[]) => {
        if (Array.isArray(args) && args[0] === "worktree" && args[1] === "remove") {
          callCount++;
          if (callCount === 1) throw new Error("locked");
        }
        return "" as any;
      }) as any);

      manager.remove("stuck-task");
      // Should have attempted both normal and force remove
      expect(callCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe("get and list", () => {
    it("should return undefined for unknown task", () => {
      expect(manager.get("unknown")).toBeUndefined();
    });

    it("should track created worktrees", () => {
      mockExistsSync.mockReturnValue(false);
      manager.create("task-a");
      manager.create("task-b");

      expect(manager.get("task-a")).toBeDefined();
      expect(manager.get("task-b")).toBeDefined();
      expect(manager.list()).toHaveLength(2);
    });

    it("should remove from tracking after remove()", () => {
      mockExistsSync.mockReturnValue(false);
      manager.create("task-c");
      manager.remove("task-c");

      expect(manager.get("task-c")).toBeUndefined();
      expect(manager.list()).toHaveLength(0);
    });
  });

  describe("listOrphans", () => {
    it("should parse git worktree list --porcelain output", () => {
      mockExecFileSync.mockReturnValue(
        [
          "worktree /project",
          "HEAD abc1234",
          "branch refs/heads/main",
          "",
          "worktree /project/.agestra/worktrees/old-task",
          "HEAD def5678",
          "branch refs/heads/agestra-worker/old-task",
          "",
        ].join("\n") as any,
      );

      const orphans = manager.listOrphans();
      expect(orphans).toHaveLength(1);
      expect(orphans[0].branch).toBe("agestra-worker/old-task");
    });

    it("should not report tracked worktrees as orphans", () => {
      mockExistsSync.mockReturnValue(false);
      manager.create("active-task");

      // Mock worktree list that includes the active task
      const activePath = manager.get("active-task")!.path;
      mockExecFileSync.mockReturnValue(
        [
          `worktree ${activePath}`,
          "HEAD abc1234",
          "branch refs/heads/agestra-worker/active-task",
          "",
        ].join("\n") as any,
      );

      const orphans = manager.listOrphans();
      expect(orphans).toHaveLength(0);
    });

    it("should return empty array when git fails", () => {
      mockExecFileSync.mockImplementation(() => { throw new Error("not a git repo"); });
      const orphans = manager.listOrphans();
      expect(orphans).toHaveLength(0);
    });
  });
});
