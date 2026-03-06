import { execFileSync } from "child_process";
import { existsSync, rmSync, mkdirSync } from "fs";
import { join } from "path";

// ── Types ────────────────────────────────────────────────────

export interface FileChange {
  path: string;
  type: "added" | "modified" | "deleted";
  insertions: number;
  deletions: number;
}

export interface FileChangeReport {
  taskId: string;
  provider: string;
  worktreePath: string | null;
  branch: string | null;
  changes: FileChange[];
  diffStat: string;
  fullDiff: string;
}

interface WorktreeInfo {
  path: string;
  branch: string;
}

// ── Tracker ──────────────────────────────────────────────────

export class FileChangeTracker {
  private worktrees = new Map<string, WorktreeInfo>();
  private worktreeBaseDir: string;

  constructor(private baseDir: string) {
    this.worktreeBaseDir = join(baseDir, ".agestra", "worktrees");
  }

  /**
   * Check if baseDir is inside a git repository.
   */
  isGitRepo(): boolean {
    try {
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: this.baseDir,
        stdio: "pipe",
        timeout: 5_000,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create an isolated git worktree for a task.
   * Returns null if not a git repo.
   */
  createWorktree(taskId: string): WorktreeInfo | null {
    if (!this.isGitRepo()) return null;

    const sanitizedId = taskId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
    const branch = `agestra/task/${sanitizedId}`;
    const worktreePath = join(this.worktreeBaseDir, sanitizedId);

    // Ensure parent dir exists
    mkdirSync(this.worktreeBaseDir, { recursive: true });

    // Clean up if leftover exists
    if (existsSync(worktreePath)) {
      try {
        this.execGit(["worktree", "remove", worktreePath, "--force"], this.baseDir);
      } catch {
        rmSync(worktreePath, { recursive: true, force: true });
      }
    }

    // Delete branch if leftover exists
    try {
      this.execGit(["branch", "-D", branch], this.baseDir);
    } catch {
      // branch doesn't exist, fine
    }

    // Create worktree with new branch
    try {
      this.execGit(["worktree", "add", "-b", branch, worktreePath, "HEAD"], this.baseDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to create worktree: ${msg}`);
    }

    const info: WorktreeInfo = { path: worktreePath, branch };
    this.worktrees.set(taskId, info);
    return info;
  }

  /**
   * Capture file changes in a worktree (or the main repo).
   */
  captureChanges(taskId: string, provider: string): FileChangeReport {
    const info = this.worktrees.get(taskId);
    const cwd = info?.path ?? this.baseDir;

    // Stage untracked files with intent-to-add so they appear in diffs
    this.execGit(["add", "-N", "."], cwd);

    const diffStat = this.execGit(["diff", "--stat", "HEAD"], cwd);
    const fullDiff = this.execGit(["diff", "HEAD"], cwd);
    const numstat = this.execGit(["diff", "--numstat", "HEAD"], cwd);

    const changes = this.parseNumstat(numstat);

    return {
      taskId,
      provider,
      worktreePath: info?.path ?? null,
      branch: info?.branch ?? null,
      changes,
      diffStat,
      fullDiff,
    };
  }

  /**
   * Accept changes: commit in worktree, merge to main branch.
   */
  acceptChanges(taskId: string, message?: string): { merged: string[] } {
    const info = this.worktrees.get(taskId);
    if (!info) throw new Error(`No worktree found for task: ${taskId}`);

    const cwd = info.path;
    const commitMsg = message ?? `agestra: task ${taskId}`;

    // Stage and commit all changes in worktree
    this.execGit(["add", "-A"], cwd);

    // Check if there's anything to commit
    const status = this.execGit(["status", "--porcelain"], cwd);
    if (!status.trim()) {
      this.cleanup(taskId);
      return { merged: [] };
    }

    this.execGit(["commit", "-m", commitMsg], cwd);

    // Get the list of changed files before merge
    const files = status.trim().split("\n").map((line) => line.trim().slice(3));

    // Merge into the current branch of the main repo
    this.execGit(["merge", info.branch, "--no-edit"], this.baseDir);

    // Cleanup
    this.cleanup(taskId);

    return { merged: files };
  }

  /**
   * Reject changes: delete worktree and branch.
   */
  rejectChanges(taskId: string): void {
    this.cleanup(taskId);
  }

  /**
   * Clean up worktree and branch for a task.
   */
  cleanup(taskId: string): void {
    const info = this.worktrees.get(taskId);
    if (!info) return;

    try {
      this.execGit(["worktree", "remove", info.path, "--force"], this.baseDir);
    } catch {
      if (existsSync(info.path)) {
        rmSync(info.path, { recursive: true, force: true });
      }
    }

    try {
      this.execGit(["branch", "-D", info.branch], this.baseDir);
    } catch {
      // branch may already be deleted
    }

    this.worktrees.delete(taskId);
  }

  /**
   * Get the worktree path for a task (if it exists).
   */
  getWorktreePath(taskId: string): string | null {
    return this.worktrees.get(taskId)?.path ?? null;
  }

  private execGit(args: string[], cwd: string): string {
    try {
      return execFileSync("git", args, {
        cwd,
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 30_000,
      }).trim();
    } catch {
      return "";
    }
  }

  private parseNumstat(numstat: string): FileChange[] {
    if (!numstat.trim()) return [];

    return numstat.trim().split("\n").map((line) => {
      const parts = line.split("\t");
      if (parts.length < 3) return null;

      const insertions = parts[0] === "-" ? 0 : parseInt(parts[0], 10) || 0;
      const deletions = parts[1] === "-" ? 0 : parseInt(parts[1], 10) || 0;
      const path = parts[2];

      let type: FileChange["type"] = "modified";
      if (insertions > 0 && deletions === 0) type = "added";
      if (insertions === 0 && deletions > 0) type = "deleted";

      return { path, type, insertions, deletions };
    }).filter(Boolean) as FileChange[];
  }
}
