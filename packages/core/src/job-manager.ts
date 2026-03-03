import { mkdirSync, readFileSync, readdirSync, existsSync, unlinkSync, rmdirSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { atomicWriteSync, atomicWriteJsonSync } from "./atomic-write.js";
import { isValidJobId } from "./path-guard.js";
import type { JobDescriptor, JobStatus, JobResult, JobState } from "./job-types.js";

const DEFAULT_TIMEOUT = 300_000; // 5 minutes
const JOBS_DIR_NAME = ".agestra/.jobs";
const STALE_THRESHOLD_MS = 30_000; // 30 seconds

export interface JobManagerOptions {
  maxJobs?: number;
  maxAgeDays?: number;
}

const DEFAULT_MAX_JOBS = 100;
const DEFAULT_MAX_AGE_DAYS = 7;

export interface JobSubmitOptions {
  provider: string;
  prompt: string;
  timeout?: number;
  cliCommand?: string;
  cliArgs?: string[];
}

export class JobManager {
  private jobsDir: string;
  private maxJobs: number;
  private maxAgeDays: number;
  private submitCount = 0;

  constructor(baseDir: string = process.cwd(), options?: JobManagerOptions) {
    this.jobsDir = join(baseDir, JOBS_DIR_NAME);
    mkdirSync(this.jobsDir, { recursive: true });
    this.maxJobs = options?.maxJobs ?? DEFAULT_MAX_JOBS;
    this.maxAgeDays = options?.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  }

  submit(options: JobSubmitOptions): string {
    const id = `${options.provider}-${Date.now()}-${randomUUID().slice(0, 6)}`;
    const jobDir = join(this.jobsDir, id);
    mkdirSync(jobDir, { recursive: true });

    const descriptor: JobDescriptor = {
      id,
      provider: options.provider,
      prompt: options.prompt,
      timeout: options.timeout ?? DEFAULT_TIMEOUT,
      createdAt: new Date().toISOString(),
      cliCommand: options.cliCommand,
      cliArgs: options.cliArgs,
    };

    const status: JobStatus = {
      id,
      state: "queued",
      provider: options.provider,
    };

    // Write job files atomically
    atomicWriteJsonSync(join(jobDir, "job.json"), descriptor);
    atomicWriteJsonSync(join(jobDir, "status.json"), status);
    atomicWriteSync(join(jobDir, "prompt.txt"), options.prompt);

    // Spawn detached worker
    this.spawnWorker(jobDir);

    this.submitCount++;
    if (this.submitCount % 10 === 0) {
      this.cleanup();
    }

    return id;
  }

  getStatus(jobId: string): JobStatus | null {
    if (!isValidJobId(jobId)) return null;
    const statusPath = join(this.jobsDir, jobId, "status.json");
    if (!existsSync(statusPath)) return null;
    const status = JSON.parse(readFileSync(statusPath, "utf-8")) as JobStatus;

    // Detect stale queued jobs: queued for longer than threshold → mark as error
    if (status.state === "queued") {
      const descPath = join(this.jobsDir, jobId, "job.json");
      try {
        const descriptor = JSON.parse(readFileSync(descPath, "utf-8")) as JobDescriptor;
        const elapsed = Date.now() - new Date(descriptor.createdAt).getTime();
        if (elapsed > STALE_THRESHOLD_MS) {
          const errorStatus: JobStatus = {
            ...status,
            state: "error",
            completedAt: new Date().toISOString(),
          };
          atomicWriteJsonSync(statusPath, errorStatus);
          atomicWriteSync(
            join(this.jobsDir, jobId, "error.txt"),
            "Job stalled in queued state (worker failed to start)",
          );
          return errorStatus;
        }
      } catch {
        // If we can't read the descriptor, leave status as-is
      }
    }

    return status;
  }

  getResult(jobId: string): JobResult | null {
    if (!isValidJobId(jobId)) return null;
    const status = this.getStatus(jobId);
    if (!status) return null;

    const jobDir = join(this.jobsDir, jobId);
    const result: JobResult = {
      id: jobId,
      state: status.state,
      exitCode: status.exitCode,
    };

    const outputPath = join(jobDir, "output.txt");
    if (existsSync(outputPath)) {
      result.output = readFileSync(outputPath, "utf-8");
    }

    const errorPath = join(jobDir, "error.txt");
    if (existsSync(errorPath)) {
      result.error = readFileSync(errorPath, "utf-8");
    }

    return result;
  }

  listJobs(): JobStatus[] {
    if (!existsSync(this.jobsDir)) return [];
    const dirs = readdirSync(this.jobsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory());

    const statuses: JobStatus[] = [];
    for (const dir of dirs) {
      const statusPath = join(this.jobsDir, dir.name, "status.json");
      if (existsSync(statusPath)) {
        statuses.push(JSON.parse(readFileSync(statusPath, "utf-8")) as JobStatus);
      }
    }
    return statuses;
  }

  cancel(jobId: string): boolean {
    if (!isValidJobId(jobId)) return false;
    const status = this.getStatus(jobId);
    if (!status) return false;
    if (status.state !== "queued" && status.state !== "running") return false;

    const jobDir = join(this.jobsDir, jobId);
    const cancelled: JobStatus = {
      ...status,
      state: "cancelled",
      completedAt: new Date().toISOString(),
    };
    atomicWriteJsonSync(join(jobDir, "status.json"), cancelled);
    return true;
  }

  cleanup(): number {
    if (!existsSync(this.jobsDir)) return 0;

    const dirs = readdirSync(this.jobsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory());

    const jobs: Array<{ name: string; status: JobStatus; descriptor: JobDescriptor | null }> = [];

    for (const dir of dirs) {
      const statusPath = join(this.jobsDir, dir.name, "status.json");
      const descPath = join(this.jobsDir, dir.name, "job.json");
      if (!existsSync(statusPath)) continue;

      const status = JSON.parse(readFileSync(statusPath, "utf-8")) as JobStatus;
      let descriptor: JobDescriptor | null = null;
      try {
        descriptor = JSON.parse(readFileSync(descPath, "utf-8")) as JobDescriptor;
      } catch {
        // no descriptor available
      }
      jobs.push({ name: dir.name, status, descriptor });
    }

    // Only target terminal states
    const terminal: JobState[] = ["completed", "error", "timed_out", "cancelled", "missing_cli"];
    const removable = jobs
      .filter((j) => terminal.includes(j.status.state))
      .sort((a, b) => {
        const aTime = a.descriptor?.createdAt ?? "";
        const bTime = b.descriptor?.createdAt ?? "";
        return aTime.localeCompare(bTime); // oldest first
      });

    let removed = 0;
    const now = Date.now();
    const maxAgeMs = this.maxAgeDays * 24 * 60 * 60 * 1000;
    const totalJobs = jobs.length;

    for (const job of removable) {
      const age = job.descriptor?.createdAt
        ? now - new Date(job.descriptor.createdAt).getTime()
        : Infinity;

      const overAge = age > maxAgeMs;
      const overCount = (totalJobs - removed) > this.maxJobs;

      if (!overAge && !overCount) continue;

      // Remove job directory
      const jobDir = join(this.jobsDir, job.name);
      try {
        const files = readdirSync(jobDir);
        for (const f of files) {
          unlinkSync(join(jobDir, f));
        }
        rmdirSync(jobDir);
        removed++;
      } catch {
        // Skip if can't remove
      }
    }

    return removed;
  }

  private spawnWorker(jobDir: string): void {
    const workerScript = new URL("./job-worker.js", import.meta.url).pathname;

    if (existsSync(workerScript)) {
      // Normal mode: spawn detached worker process
      const child = spawn(process.execPath, [workerScript, jobDir], {
        detached: true,
        stdio: "ignore",
      });

      child.on("error", () => {
        // Worker process failed to spawn — fall back to in-process execution
        this.runInProcess(jobDir);
      });

      child.unref();
    } else {
      // Bundle mode: worker script not available as separate file
      this.runInProcess(jobDir);
    }
  }

  private runInProcess(jobDir: string): void {
    // Dynamically import and run the worker logic in-process
    import("./job-worker.js").then(({ resolveCliConfig }) => {
      let descriptor: JobDescriptor;
      try {
        descriptor = JSON.parse(
          readFileSync(join(jobDir, "job.json"), "utf-8"),
        ) as JobDescriptor;
      } catch {
        return;
      }

      const resolved = resolveCliConfig(descriptor);
      if (!resolved) {
        const statusPath = join(jobDir, "status.json");
        const current = JSON.parse(readFileSync(statusPath, "utf-8")) as JobStatus;
        atomicWriteJsonSync(statusPath, {
          ...current,
          state: "missing_cli",
          completedAt: new Date().toISOString(),
        });
        atomicWriteSync(
          join(jobDir, "error.txt"),
          `No CLI mapping for provider: ${descriptor.provider}`,
        );
        return;
      }

      const { command, buildArgs } = resolved;
      const prompt = readFileSync(join(jobDir, "prompt.txt"), "utf-8");
      const args = buildArgs(prompt);

      // Mark running
      const statusPath = join(jobDir, "status.json");
      const currentStatus = JSON.parse(readFileSync(statusPath, "utf-8")) as JobStatus;
      atomicWriteJsonSync(statusPath, {
        ...currentStatus,
        state: "running",
        startedAt: new Date().toISOString(),
      });

      const proc = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";

      proc.stdout!.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      proc.stderr!.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      const timer = setTimeout(() => {
        proc.kill("SIGTERM");
        setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch { /* already dead */ }
        }, 3000);

        atomicWriteSync(join(jobDir, "output.txt"), stdout);
        atomicWriteSync(join(jobDir, "error.txt"), stderr);
        const s = JSON.parse(readFileSync(statusPath, "utf-8")) as JobStatus;
        atomicWriteJsonSync(statusPath, {
          ...s,
          state: "timed_out",
          completedAt: new Date().toISOString(),
        });
      }, descriptor.timeout);

      proc.on("close", (code) => {
        clearTimeout(timer);
        atomicWriteSync(join(jobDir, "output.txt"), stdout);
        atomicWriteSync(join(jobDir, "error.txt"), stderr);
        const s = JSON.parse(readFileSync(statusPath, "utf-8")) as JobStatus;
        atomicWriteJsonSync(statusPath, {
          ...s,
          state: code === 0 ? "completed" : "error",
          exitCode: code ?? 1,
          completedAt: new Date().toISOString(),
        });
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        atomicWriteSync(join(jobDir, "error.txt"), err.message);
        const s = JSON.parse(readFileSync(statusPath, "utf-8")) as JobStatus;
        atomicWriteJsonSync(statusPath, {
          ...s,
          state: "missing_cli",
          completedAt: new Date().toISOString(),
        });
      });
    }).catch(() => {
      // If dynamic import fails entirely, mark job as error
      try {
        const statusPath = join(jobDir, "status.json");
        const current = JSON.parse(readFileSync(statusPath, "utf-8")) as JobStatus;
        atomicWriteJsonSync(statusPath, {
          ...current,
          state: "error",
          completedAt: new Date().toISOString(),
        });
        atomicWriteSync(
          join(jobDir, "error.txt"),
          "Failed to load job worker module",
        );
      } catch {
        // Nothing we can do
      }
    });
  }
}
