import { spawn } from "child_process";

export interface CliRunOptions {
  command: string;
  args: string[];
  timeout?: number;
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  maxBuffer?: number;
}

export interface CliRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}

const DEFAULT_TIMEOUT = 120_000;

export function runCli(options: CliRunOptions): Promise<CliRunResult> {
  const { command, args, timeout = DEFAULT_TIMEOUT, cwd, env, stdin, maxBuffer = 10_485_760 } = options;

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      env: env ? { ...process.env, ...env } : undefined,
      stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;

    proc.stdout!.on("data", (data: Buffer) => {
      stdoutBytes += data.length;
      if (stdoutBytes <= maxBuffer) {
        stdout += data.toString();
      } else {
        truncated = true;
      }
    });
    proc.stderr!.on("data", (data: Buffer) => {
      stderrBytes += data.length;
      if (stderrBytes <= maxBuffer) {
        stderr += data.toString();
      } else {
        truncated = true;
      }
    });

    if (stdin && proc.stdin) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }

    // Activity-based timeout: resets on each stdout/stderr output.
    // Process is only killed after `timeout` ms of silence.
    const killProc = () => {
      proc.kill("SIGTERM");
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }, 3000);
      reject(
        new Error(
          `CLI timeout after ${timeout}ms of inactivity: ${command} ${args.join(" ")}`,
        ),
      );
    };

    let timer = setTimeout(killProc, timeout);

    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(killProc, timeout);
    };

    proc.stdout!.on("data", resetTimer);
    proc.stderr!.on("data", resetTimer);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1, truncated });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`CLI spawn error: ${err.message}`));
    });
  });
}
