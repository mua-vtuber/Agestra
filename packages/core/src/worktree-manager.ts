import { execFileSync } from "child_process";
import { existsSync, rmSync, mkdirSync } from "fs";
import { join } from "path";

// ── Types ────────────────────────────────────────────────────

export interface WorktreeInfo {
  id: string;
  path: string;
  branch: string;
}

export interface OrphanWorktree {
  path: string;
  branch: string;
}

// ── Manager ─────────────────────────────────────────────────

export class WorktreeManager {
  private worktrees = new Map<string, WorktreeInfo>();
  private readonly worktreeBaseDir: string;

  constructor(private readonly baseDir: string) {
    this.worktreeBaseDir = join(baseDir, ".agestra", "worktrees");
  }

  /**
   * Create a git worktree for a worker task.
   * Sanitizes the ID to prevent path traversal.
   */
  create(taskId: string): WorktreeInfo {
    const sanitizedId = taskId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
    const branch = `agestra-worker/${sanitizedId}`;
    const worktreePath = join(this.worktreeBaseDir, sanitizedId);

    mkdirSync(this.worktreeBaseDir, { recursive: true });

    // Clean up leftover worktree if exists
    if (existsSync(worktreePath)) {
      this.forceRemoveWorktree(worktreePath);
    }

    // Delete leftover branch
    this.gitSafe(["branch", "-D", branch]);

    // Create worktree with new branch from HEAD
    this.git(["worktree", "add", "-b", branch, worktreePath, "HEAD"]);

    const info: WorktreeInfo = { id: taskId, path: worktreePath, branch };
    this.worktrees.set(taskId, info);
    return info;
  }

  /**
   * Remove a worktree and its branch. Falls back to force-remove.
   */
  remove(taskId: string): void {
    const info = this.worktrees.get(taskId);
    if (!info) return;

    this.forceRemoveWorktree(info.path);
    this.gitSafe(["branch", "-D", info.branch]);
    this.worktrees.delete(taskId);
  }

  /**
   * Get info for a tracked worktree.
   */
  get(taskId: string): WorktreeInfo | undefined {
    return this.worktrees.get(taskId);
  }

  /**
   * List all tracked worktrees.
   */
  list(): WorktreeInfo[] {
    return [...this.worktrees.values()];
  }

  /**
   * Detect orphan worktrees — exist on disk/git but not tracked by this manager.
   * Useful for cleanup after crash/restart.
   */
  listOrphans(): OrphanWorktree[] {
    const output = this.gitSafe(["worktree", "list", "--porcelain"]);
    if (!output) return [];

    const orphans: OrphanWorktree[] = [];
    let currentPath = "";
    let currentBranch = "";

    const flush = (): void => {
      if (
        currentPath.includes(".agestra/worktrees") &&
        currentBranch.startsWith("agestra-worker/")
      ) {
        const isTracked = [...this.worktrees.values()].some(
          (w) => w.path === currentPath,
        );
        if (!isTracked) {
          orphans.push({ path: currentPath, branch: currentBranch });
        }
      }
      currentPath = "";
      currentBranch = "";
    };

    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) {
        currentPath = line.slice("worktree ".length);
      } else if (line.startsWith("branch refs/heads/")) {
        currentBranch = line.slice("branch refs/heads/".length);
      } else if (line === "") {
        flush();
      }
    }

    // Flush the last entry if the output didn't end with an empty line
    if (currentPath) {
      flush();
    }

    return orphans;
  }

  /**
   * Clean up orphan worktrees. Returns number cleaned.
   */
  cleanOrphans(): number {
    const orphans = this.listOrphans();
    let cleaned = 0;

    for (const orphan of orphans) {
      this.forceRemoveWorktree(orphan.path);
      this.gitSafe(["branch", "-D", orphan.branch]);
      cleaned++;
    }

    return cleaned;
  }

  // ── Private helpers ────────────────────────────────────────

  private forceRemoveWorktree(worktreePath: string): void {
    if (this.gitSafe(["worktree", "remove", worktreePath]) !== null) return;
    if (this.gitSafe(["worktree", "remove", "--force", worktreePath]) !== null) return;

    // Last resort: manual directory deletion
    if (existsSync(worktreePath)) {
      rmSync(worktreePath, { recursive: true, force: true });
    }
    this.gitSafe(["worktree", "prune"]);
  }

  private git(args: string[]): string {
    return execFileSync("git", args, {
      cwd: this.baseDir,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 30_000,
    }).trim();
  }

  private gitSafe(args: string[]): string | null {
    try {
      return this.git(args);
    } catch {
      return null;
    }
  }
}
