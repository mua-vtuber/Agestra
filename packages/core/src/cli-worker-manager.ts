import { spawn as nodeSpawn, type ChildProcess } from "child_process";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import { scanForSecrets } from "./secret-scanner.js";
import { generateManifest, validateManifest } from "./task-manifest.js";

// ── FSM States ──────────────────────────────────────────────

export enum WorkerState {
  SPAWNING = "SPAWNING",
  RUNNING = "RUNNING",
  COLLECTING = "COLLECTING",
  COMPLETED = "COMPLETED",
  FAILED = "FAILED",
  CANCELLING = "CANCELLING",
  CANCELLED = "CANCELLED",
  TIMEOUT = "TIMEOUT",
}

// ── Types ────────────────────────────────────────────────────

export interface WorkerSpawnArgs {
  provider: "codex" | "gemini";
  taskDescription: string;
  workingDir: string;
  filesToRead?: string[];
  filesToModify?: string[];
  constraints?: string;
  successCriteria?: string[];
  useWorktree?: boolean;
  useTmux?: boolean;
  timeoutMinutes?: number;
}

export interface WorkerInfo {
  workerId: string;
  provider: "codex" | "gemini";
  state: WorkerState;
  pid: number | null;
  worktreePath: string | null;
  worktreeBranch: string | null;
  startedAt: number;
  retryCount: number;
  exitCode: number | null;
  error: string | null;
}

export interface WorkerStatusResult {
  workerId: string;
  provider: string;
  state: WorkerState;
  elapsedSeconds: number;
  pid: number | null;
  outputTail: string;
  worktreeBranch: string | null;
  retryCount: number;
}

export interface WorkerCollectResult {
  workerId: string;
  state: WorkerState;
  exitCode: number | null;
  outputFull: string;
  gitDiff: string;
  filesChanged: string[];
  worktreeBranch: string | null;
}

// ── Internal worker record ──────────────────────────────────

interface WorkerRecord {
  info: WorkerInfo;
  process: ChildProcess | null;
  workerDir: string;
  manifestPath: string;
  outputPath: string;
  errorPath: string;
}

// ── Manager ─────────────────────────────────────────────────

export class CliWorkerManager {
  private workers = new Map<string, WorkerRecord>();
  private readonly workersBaseDir: string;

  constructor(private readonly baseDir: string) {
    this.workersBaseDir = join(baseDir, ".agestra", "workers");
  }

  /**
   * Spawn a CLI worker in autonomous mode.
   * Runs preflight security check, generates task manifest, spawns process.
   */
  spawn(args: WorkerSpawnArgs): WorkerInfo {
    // Preflight: secret scan
    const scanInput = [
      args.taskDescription,
      args.constraints ?? "",
    ];
    const scanResult = scanForSecrets(scanInput);
    if (!scanResult.clean) {
      const details = scanResult.findings.map((f) => f.pattern).join(", ");
      throw new Error(`Secret detected in task input — spawn blocked. Found: ${details}`);
    }

    // Generate worker ID
    const hex = randomBytes(3).toString("hex");
    const workerId = `${args.provider}-${Date.now()}-${hex}`;

    // Create worker directory
    const workerDir = join(this.workersBaseDir, workerId);
    mkdirSync(workerDir, { recursive: true });

    // Generate and write task manifest
    const manifest = generateManifest({
      taskDescription: args.taskDescription,
      workingDir: args.workingDir,
      filesToRead: args.filesToRead,
      filesToModify: args.filesToModify,
      constraints: args.constraints,
      successCriteria: args.successCriteria,
      timeoutMinutes: args.timeoutMinutes,
    });

    const validation = validateManifest(manifest);
    if (!validation.valid) {
      throw new Error(`Invalid task manifest: ${validation.errors.join(", ")}`);
    }

    const manifestPath = join(workerDir, "task-manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

    // Output/error file paths
    const outputPath = join(workerDir, "stdout.log");
    const errorPath = join(workerDir, "stderr.log");

    // Spawn CLI process (array-based args, injection-safe)
    const cliArgs = this.buildCliArgs(args.provider, manifestPath);
    const cwd = args.workingDir;

    const proc = nodeSpawn(cliArgs[0], cliArgs.slice(1), {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.unref();

    // Set up output capture
    const outputChunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];

    proc.stdout?.on("data", (chunk: Buffer) => outputChunks.push(chunk));
    proc.stderr?.on("data", (chunk: Buffer) => errorChunks.push(chunk));

    const info: WorkerInfo = {
      workerId,
      provider: args.provider,
      state: WorkerState.RUNNING,
      pid: proc.pid ?? null,
      worktreePath: null,
      worktreeBranch: null,
      startedAt: Date.now(),
      retryCount: 0,
      exitCode: null,
      error: null,
    };

    const record: WorkerRecord = {
      info,
      process: proc,
      workerDir,
      manifestPath,
      outputPath,
      errorPath,
    };

    this.workers.set(workerId, record);

    // Handle process exit
    proc.on("close", (code: number | null) => {
      record.info.exitCode = code;

      // Write output to files
      try {
        writeFileSync(outputPath, Buffer.concat(outputChunks).toString("utf-8"));
        writeFileSync(errorPath, Buffer.concat(errorChunks).toString("utf-8"));
      } catch {
        // Ignore write errors during cleanup
      }

      if (record.info.state === WorkerState.CANCELLING) {
        record.info.state = WorkerState.CANCELLED;
      } else if (code === 0) {
        record.info.state = WorkerState.COLLECTING;
        // Auto-transition to COMPLETED after collection
        record.info.state = WorkerState.COMPLETED;
      } else {
        record.info.state = WorkerState.FAILED;
        record.info.error = `Process exited with code ${code}`;
      }
    });

    return info;
  }

  /**
   * Get current status of a worker.
   */
  getStatus(workerId: string): WorkerStatusResult | undefined {
    const record = this.workers.get(workerId);
    if (!record) return undefined;

    const elapsed = Math.floor((Date.now() - record.info.startedAt) / 1000);

    let outputTail = "";
    try {
      if (existsSync(record.outputPath)) {
        const full = readFileSync(record.outputPath, "utf-8");
        const lines = full.split("\n");
        outputTail = lines.slice(-20).join("\n");
      }
    } catch {
      // File may not exist yet
    }

    return {
      workerId: record.info.workerId,
      provider: record.info.provider,
      state: record.info.state,
      elapsedSeconds: elapsed,
      pid: record.info.pid,
      outputTail,
      worktreeBranch: record.info.worktreeBranch,
      retryCount: record.info.retryCount,
    };
  }

  /**
   * Collect results from a completed/failed worker.
   */
  collect(workerId: string): WorkerCollectResult | undefined {
    const record = this.workers.get(workerId);
    if (!record) return undefined;

    let outputFull = "";
    try {
      if (existsSync(record.outputPath)) {
        outputFull = readFileSync(record.outputPath, "utf-8");
      }
    } catch { /* ignore */ }

    return {
      workerId: record.info.workerId,
      state: record.info.state,
      exitCode: record.info.exitCode,
      outputFull,
      gitDiff: "", // Will be populated when worktree integration is active
      filesChanged: [],
      worktreeBranch: record.info.worktreeBranch,
    };
  }

  /**
   * Stop a running worker. Sends SIGTERM, then SIGKILL after 5s.
   */
  stop(workerId: string): void {
    const record = this.workers.get(workerId);
    if (!record || !record.process) return;

    if (record.info.state !== WorkerState.RUNNING) return;

    record.info.state = WorkerState.CANCELLING;

    try {
      record.process.kill("SIGTERM");
    } catch {
      // Process may already be dead
    }

    // Force kill after 5 seconds
    setTimeout(() => {
      if (record.info.state === WorkerState.CANCELLING) {
        try {
          record.process?.kill("SIGKILL");
        } catch { /* ignore */ }
        record.info.state = WorkerState.CANCELLED;
      }
    }, 5000);
  }

  /**
   * List all tracked workers.
   */
  listAll(): WorkerInfo[] {
    return [...this.workers.values()].map((r) => ({ ...r.info }));
  }

  // ── Private helpers ────────────────────────────────────────

  private buildCliArgs(provider: "codex" | "gemini", manifestPath: string): string[] {
    switch (provider) {
      case "codex":
        return ["codex", "exec", "--full-auto", "-f", manifestPath];
      case "gemini":
        return ["gemini", "exec", "--full-auto", "-f", manifestPath];
    }
  }
}
