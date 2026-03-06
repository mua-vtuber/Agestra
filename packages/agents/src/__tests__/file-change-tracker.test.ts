import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { FileChangeTracker } from "../file-change-tracker.js";

function setupGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "agestra-fct-"));
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: "pipe" });
  execSync('git config user.name "Test"', { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "initial.txt"), "initial content\n");
  execSync("git add -A && git commit -m 'initial'", { cwd: dir, stdio: "pipe" });
  return dir;
}

describe("FileChangeTracker", () => {
  let repoDir: string;
  let tracker: FileChangeTracker;

  beforeEach(() => {
    repoDir = setupGitRepo();
    tracker = new FileChangeTracker(repoDir);
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  describe("isGitRepo", () => {
    it("should return true for git repos", () => {
      expect(tracker.isGitRepo()).toBe(true);
    });

    it("should return false for non-git dirs", () => {
      const nonGit = mkdtempSync(join(tmpdir(), "agestra-nongit-"));
      const t = new FileChangeTracker(nonGit);
      expect(t.isGitRepo()).toBe(false);
      rmSync(nonGit, { recursive: true, force: true });
    });
  });

  describe("createWorktree", () => {
    it("should create a worktree with new branch", () => {
      const info = tracker.createWorktree("test-task-1");
      expect(info).not.toBeNull();
      expect(info!.branch).toBe("agestra/task/test-task-1");
      expect(info!.path).toContain("test-task-1");

      // Verify worktree exists
      const worktrees = execSync("git worktree list", { cwd: repoDir, encoding: "utf-8" });
      expect(worktrees).toContain("test-task-1");

      tracker.cleanup("test-task-1");
    });

    it("should return null for non-git dirs", () => {
      const nonGit = mkdtempSync(join(tmpdir(), "agestra-nongit-"));
      const t = new FileChangeTracker(nonGit);
      expect(t.createWorktree("task")).toBeNull();
      rmSync(nonGit, { recursive: true, force: true });
    });
  });

  describe("captureChanges", () => {
    it("should detect file changes in worktree", () => {
      const info = tracker.createWorktree("capture-test");
      expect(info).not.toBeNull();

      // Make a change in the worktree
      writeFileSync(join(info!.path, "new-file.txt"), "hello world\n");

      const report = tracker.captureChanges("capture-test", "gemini");
      expect(report.taskId).toBe("capture-test");
      expect(report.provider).toBe("gemini");
      expect(report.changes.length).toBeGreaterThan(0);
      expect(report.changes[0].path).toBe("new-file.txt");
      expect(report.diffStat).toContain("new-file.txt");

      tracker.cleanup("capture-test");
    });
  });

  describe("acceptChanges", () => {
    it("should merge worktree changes into main branch", () => {
      const info = tracker.createWorktree("accept-test");
      expect(info).not.toBeNull();

      writeFileSync(join(info!.path, "accepted.txt"), "accepted content\n");

      const result = tracker.acceptChanges("accept-test", "test merge");
      expect(result.merged).toContain("accepted.txt");

      // Verify file exists in main repo
      const content = execSync("cat accepted.txt", { cwd: repoDir, encoding: "utf-8" });
      expect(content.trim()).toBe("accepted content");
    });

    it("should safely handle special characters in commit messages", () => {
      const info = tracker.createWorktree("special-chars-test");
      expect(info).not.toBeNull();

      writeFileSync(join(info!.path, "special.txt"), "test\n");

      // Commit messages with shell-dangerous characters should not cause injection
      const dangerousMsg = 'fix: handle $HOME and `whoami` and "quotes"';
      const result = tracker.acceptChanges("special-chars-test", dangerousMsg);
      expect(result.merged).toContain("special.txt");

      // Verify commit message was stored literally
      const log = execSync("git log -1 --format=%s", { cwd: repoDir, encoding: "utf-8" });
      expect(log.trim()).toBe(dangerousMsg);
    });
  });

  describe("rejectChanges", () => {
    it("should discard worktree and branch", () => {
      const info = tracker.createWorktree("reject-test");
      expect(info).not.toBeNull();

      writeFileSync(join(info!.path, "rejected.txt"), "rejected content\n");
      tracker.rejectChanges("reject-test");

      // Verify worktree is gone
      expect(tracker.getWorktreePath("reject-test")).toBeNull();

      // Verify branch is gone
      const branches = execSync("git branch", { cwd: repoDir, encoding: "utf-8" });
      expect(branches).not.toContain("agestra/task/reject-test");
    });
  });
});
