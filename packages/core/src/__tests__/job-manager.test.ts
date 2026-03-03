import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { JobManager } from "../job-manager.js";
import type { JobStatus, JobDescriptor } from "../job-types.js";

// Mock child_process.spawn to avoid actually spawning workers
vi.mock("child_process", () => ({
  spawn: vi.fn(() => {
    const child = { unref: vi.fn(), pid: 12345 };
    return child;
  }),
}));

describe("JobManager", () => {
  let tmp: string;
  let manager: JobManager;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "job-mgr-"));
    manager = new JobManager(tmp);
  });

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("should create job directory structure on submit", () => {
    const jobId = manager.submit({
      provider: "gemini",
      prompt: "hello world",
    });

    expect(jobId).toContain("gemini-");

    const jobDir = join(tmp, ".agestra/.jobs", jobId);
    expect(existsSync(join(jobDir, "job.json"))).toBe(true);
    expect(existsSync(join(jobDir, "status.json"))).toBe(true);
    expect(existsSync(join(jobDir, "prompt.txt"))).toBe(true);

    const descriptor = JSON.parse(readFileSync(join(jobDir, "job.json"), "utf-8"));
    expect(descriptor.provider).toBe("gemini");
    expect(descriptor.prompt).toBe("hello world");

    const status = JSON.parse(readFileSync(join(jobDir, "status.json"), "utf-8"));
    expect(status.state).toBe("queued");
  });

  it("should return job status", () => {
    const jobId = manager.submit({
      provider: "codex",
      prompt: "test prompt",
      timeout: 60000,
    });

    const status = manager.getStatus(jobId);
    expect(status).not.toBeNull();
    expect(status!.state).toBe("queued");
    expect(status!.provider).toBe("codex");
  });

  it("should return null for unknown job", () => {
    expect(manager.getStatus("nonexistent")).toBeNull();
  });

  it("should list all jobs", () => {
    manager.submit({ provider: "gemini", prompt: "p1" });
    manager.submit({ provider: "codex", prompt: "p2" });

    const jobs = manager.listJobs();
    expect(jobs).toHaveLength(2);
  });

  it("should cancel a queued job", () => {
    const jobId = manager.submit({ provider: "gemini", prompt: "cancel me" });

    expect(manager.cancel(jobId)).toBe(true);

    const status = manager.getStatus(jobId);
    expect(status!.state).toBe("cancelled");
    expect(status!.completedAt).toBeDefined();
  });

  it("should not cancel an already completed job", () => {
    const jobId = manager.submit({ provider: "gemini", prompt: "done" });

    // Manually mark completed
    const jobDir = join(tmp, ".agestra/.jobs", jobId);
    const status: JobStatus = {
      id: jobId,
      state: "completed",
      provider: "gemini",
      completedAt: new Date().toISOString(),
    };
    writeFileSync(join(jobDir, "status.json"), JSON.stringify(status));

    expect(manager.cancel(jobId)).toBe(false);
  });

  it("should return result with output and error files", () => {
    const jobId = manager.submit({ provider: "gemini", prompt: "result test" });

    // Simulate completed job with output
    const jobDir = join(tmp, ".agestra/.jobs", jobId);
    const status: JobStatus = {
      id: jobId,
      state: "completed",
      provider: "gemini",
      exitCode: 0,
      completedAt: new Date().toISOString(),
    };
    writeFileSync(join(jobDir, "status.json"), JSON.stringify(status));
    writeFileSync(join(jobDir, "output.txt"), "hello output");
    writeFileSync(join(jobDir, "error.txt"), "");

    const result = manager.getResult(jobId);
    expect(result).not.toBeNull();
    expect(result!.state).toBe("completed");
    expect(result!.output).toBe("hello output");
    expect(result!.exitCode).toBe(0);
  });

  it("should use custom timeout", () => {
    const jobId = manager.submit({
      provider: "gemini",
      prompt: "timeout test",
      timeout: 60000,
    });

    const jobDir = join(tmp, ".agestra/.jobs", jobId);
    const descriptor = JSON.parse(readFileSync(join(jobDir, "job.json"), "utf-8"));
    expect(descriptor.timeout).toBe(60000);
  });

  // ── A2: Job GC tests ────────────────────────────────────────

  function createFakeJob(
    jobsDir: string,
    name: string,
    state: string,
    createdAt: string,
  ): void {
    const jobDir = join(jobsDir, name);
    mkdirSync(jobDir, { recursive: true });

    const descriptor: JobDescriptor = {
      id: name,
      provider: "gemini",
      prompt: "test",
      timeout: 300000,
      createdAt,
    };
    const status: JobStatus = {
      id: name,
      state: state as JobStatus["state"],
      provider: "gemini",
    };

    writeFileSync(join(jobDir, "job.json"), JSON.stringify(descriptor));
    writeFileSync(join(jobDir, "status.json"), JSON.stringify(status));
    writeFileSync(join(jobDir, "prompt.txt"), "test");
  }

  it("cleanup removes old completed jobs", () => {
    const mgr = new JobManager(tmp, { maxJobs: 100, maxAgeDays: 1 });
    const jobsDir = join(tmp, ".agestra/.jobs");

    // Create a completed job with old timestamp (10 days ago)
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    createFakeJob(jobsDir, "old-completed-job", "completed", oldDate);

    expect(existsSync(join(jobsDir, "old-completed-job"))).toBe(true);

    const removed = mgr.cleanup();
    expect(removed).toBe(1);
    expect(existsSync(join(jobsDir, "old-completed-job"))).toBe(false);
  });

  it("cleanup preserves running jobs", () => {
    const mgr = new JobManager(tmp, { maxJobs: 1, maxAgeDays: 0 });
    const jobsDir = join(tmp, ".agestra/.jobs");

    // Create a running job (should never be removed)
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    createFakeJob(jobsDir, "running-job", "running", oldDate);

    const removed = mgr.cleanup();
    expect(removed).toBe(0);
    expect(existsSync(join(jobsDir, "running-job"))).toBe(true);
  });

  it("cleanup removes jobs when count exceeds maxJobs", () => {
    const mgr = new JobManager(tmp, { maxJobs: 2, maxAgeDays: 365 });
    const jobsDir = join(tmp, ".agestra/.jobs");

    // Create 4 completed jobs (recent, so age won't trigger removal)
    const now = new Date().toISOString();
    createFakeJob(jobsDir, "job-a", "completed", "2020-01-01T00:00:00.000Z");
    createFakeJob(jobsDir, "job-b", "completed", "2020-01-02T00:00:00.000Z");
    createFakeJob(jobsDir, "job-c", "completed", now);
    createFakeJob(jobsDir, "job-d", "completed", now);

    const removed = mgr.cleanup();
    // 4 total, maxJobs=2, so 2 oldest should be removed
    expect(removed).toBe(2);
    expect(existsSync(join(jobsDir, "job-a"))).toBe(false);
    expect(existsSync(join(jobsDir, "job-b"))).toBe(false);
  });

  it("cleanup respects maxAgeDays TTL", () => {
    const mgr = new JobManager(tmp, { maxJobs: 100, maxAgeDays: 3 });
    const jobsDir = join(tmp, ".agestra/.jobs");

    const oldDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const recentDate = new Date().toISOString();

    createFakeJob(jobsDir, "expired-job", "completed", oldDate);
    createFakeJob(jobsDir, "recent-job", "completed", recentDate);

    const removed = mgr.cleanup();
    expect(removed).toBe(1);
    expect(existsSync(join(jobsDir, "expired-job"))).toBe(false);
    expect(existsSync(join(jobsDir, "recent-job"))).toBe(true);
  });

  // ── A3: cliCommand / cliArgs in job.json ────────────────────

  it("submit includes cliCommand and cliArgs in job.json", () => {
    const jobId = manager.submit({
      provider: "custom-provider",
      prompt: "hello",
      cliCommand: "/usr/bin/my-cli",
      cliArgs: ["--mode", "fast", "{prompt}"],
    });

    const jobDir = join(tmp, ".agestra/.jobs", jobId);
    const descriptor = JSON.parse(readFileSync(join(jobDir, "job.json"), "utf-8"));
    expect(descriptor.cliCommand).toBe("/usr/bin/my-cli");
    expect(descriptor.cliArgs).toEqual(["--mode", "fast", "{prompt}"]);
  });
});

// ── A3: resolveCliConfig runtime tests ──────────────────────
import { resolveCliConfig } from "../job-worker.js";

describe("resolveCliConfig", () => {
  it("uses cliCommand/cliArgs from descriptor when present", () => {
    const resolved = resolveCliConfig({
      provider: "gemini",
      cliCommand: "/usr/bin/custom-cli",
      cliArgs: ["--flag", "{prompt}", "--end"],
    });

    expect(resolved).not.toBeNull();
    expect(resolved!.command).toBe("/usr/bin/custom-cli");
    expect(resolved!.buildArgs("hello world")).toEqual(["--flag", "hello world", "--end"]);
  });

  it("substitutes {prompt} placeholder in cliArgs", () => {
    const resolved = resolveCliConfig({
      provider: "any",
      cliCommand: "my-tool",
      cliArgs: ["-p", "{prompt}"],
    });

    expect(resolved!.buildArgs("test prompt")).toEqual(["-p", "test prompt"]);
  });

  it("defaults to [prompt] when cliCommand set but cliArgs missing", () => {
    const resolved = resolveCliConfig({
      provider: "any",
      cliCommand: "my-tool",
    });

    expect(resolved!.command).toBe("my-tool");
    expect(resolved!.buildArgs("hello")).toEqual(["hello"]);
  });

  it("falls back to hardcoded provider mapping when no cliCommand", () => {
    const resolved = resolveCliConfig({ provider: "gemini" });

    expect(resolved).not.toBeNull();
    expect(resolved!.command).toBe("gemini");
    expect(resolved!.buildArgs("test")).toEqual(["-p", "test"]);
  });

  it("falls back to codex-cli mapping", () => {
    const resolved = resolveCliConfig({ provider: "codex-cli" });

    expect(resolved).not.toBeNull();
    expect(resolved!.command).toBe("codex");
    expect(resolved!.buildArgs("hi")).toEqual(["exec", "--full-auto", "--ephemeral", "hi"]);
  });

  it("returns null for unknown provider without cliCommand", () => {
    const resolved = resolveCliConfig({ provider: "unknown-provider" });
    expect(resolved).toBeNull();
  });
});
