#!/usr/bin/env node
/**
 * Detached worker process for long-running CLI jobs.
 * Usage: node job-worker.js <jobDir>
 *
 * Reads job.json from jobDir, runs the appropriate CLI provider,
 * writes output to output.txt/error.txt, and updates status.json.
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";
import { atomicWriteSync, atomicWriteJsonSync } from "./atomic-write.js";
import type { JobDescriptor, JobStatus } from "./job-types.js";
import { isAllowedCliCommand } from "./path-guard.js";

export interface ProviderCliMapping {
  command: string;
  buildArgs: (prompt: string) => string[];
}

export const CLI_PROVIDERS: Record<string, ProviderCliMapping> = {
  gemini: {
    command: "gemini",
    buildArgs: (prompt) => ["-p", prompt],
  },
  "gemini-cli": {
    command: "gemini",
    buildArgs: (prompt) => ["-p", prompt],
  },
  codex: {
    command: "codex",
    buildArgs: (prompt) => ["exec", "--full-auto", "--ephemeral", prompt],
  },
  "codex-cli": {
    command: "codex",
    buildArgs: (prompt) => ["exec", "--full-auto", "--ephemeral", prompt],
  },
};

/**
 * Resolve CLI command and args from a job descriptor.
 * Prefers descriptor-level cliCommand/cliArgs over hardcoded provider mappings.
 * Returns null if no mapping is found.
 */
export function resolveCliConfig(
  descriptor: Pick<JobDescriptor, "provider" | "cliCommand" | "cliArgs">,
): { command: string; buildArgs: (prompt: string) => string[] } | null {
  if (descriptor.cliCommand) {
    if (!isAllowedCliCommand(descriptor.cliCommand)) {
      return null;
    }
    return {
      command: descriptor.cliCommand,
      buildArgs: (prompt: string) => {
        if (descriptor.cliArgs) {
          return descriptor.cliArgs.map(arg => arg === "{prompt}" ? prompt : arg);
        }
        return [prompt];
      },
    };
  }

  const mapping = CLI_PROVIDERS[descriptor.provider];
  return mapping ?? null;
}

function updateStatus(jobDir: string, patch: Partial<JobStatus>): void {
  const statusPath = join(jobDir, "status.json");
  const current = JSON.parse(readFileSync(statusPath, "utf-8")) as JobStatus;
  atomicWriteJsonSync(statusPath, { ...current, ...patch });
}

async function main(): Promise<void> {
  const jobDir = process.argv[2];
  if (!jobDir) {
    process.exit(1);
  }

  let descriptor: JobDescriptor;
  try {
    descriptor = JSON.parse(
      readFileSync(join(jobDir, "job.json"), "utf-8"),
    ) as JobDescriptor;
  } catch {
    process.exit(1);
  }

  // Prefer descriptor-level CLI config, fallback to hardcoded mapping
  const resolved = resolveCliConfig(descriptor);
  if (!resolved) {
    updateStatus(jobDir, {
      state: "missing_cli",
      completedAt: new Date().toISOString(),
    });
    atomicWriteSync(
      join(jobDir, "error.txt"),
      `No CLI mapping for provider: ${descriptor.provider}`,
    );
    process.exit(1);
  }
  const { command, buildArgs } = resolved;

  // Mark running
  updateStatus(jobDir, {
    state: "running",
    startedAt: new Date().toISOString(),
  });

  const prompt = readFileSync(join(jobDir, "prompt.txt"), "utf-8");
  const args = buildArgs(prompt);

  return new Promise<void>((resolve) => {
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
      updateStatus(jobDir, {
        state: "timed_out",
        completedAt: new Date().toISOString(),
      });
      resolve();
    }, descriptor.timeout);

    proc.on("close", (code) => {
      clearTimeout(timer);
      atomicWriteSync(join(jobDir, "output.txt"), stdout);
      atomicWriteSync(join(jobDir, "error.txt"), stderr);
      updateStatus(jobDir, {
        state: code === 0 ? "completed" : "error",
        exitCode: code ?? 1,
        completedAt: new Date().toISOString(),
      });
      resolve();
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      atomicWriteSync(join(jobDir, "error.txt"), err.message);
      updateStatus(jobDir, {
        state: "missing_cli",
        completedAt: new Date().toISOString(),
      });
      resolve();
    });
  });
}

// Only run when executed directly, not when imported
const isMainModule = process.argv[1]?.endsWith("job-worker.js") || process.argv[1]?.endsWith("job-worker.ts");
if (isMainModule) {
  main().catch(() => process.exit(1));
}
