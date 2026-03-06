import { execSync } from "child_process";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

// ── Types ────────────────────────────────────────────────────

export interface AutoQAConfig {
  designDoc?: string;
  buildCommand?: string;
  testCommand?: string;
  timeoutMs?: number;
}

export interface AutoQAResult {
  buildPassed: boolean;
  buildOutput: string;
  testsPassed: boolean;
  testOutput: string;
  designDoc?: string;
  summary: string;
}

// ── Constants ────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes per command
const MAX_OUTPUT_LENGTH = 10_000;

// ── AutoQA ──────────────────────────────────────────────────

export class AutoQA {
  constructor(private baseDir: string) {}

  async run(config: AutoQAConfig = {}): Promise<AutoQAResult> {
    const timeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Detect commands
    const buildCmd = config.buildCommand ?? this.detectBuildCommand();
    const testCmd = config.testCommand ?? this.detectTestCommand();
    const designDoc = config.designDoc ?? this.detectDesignDoc();

    // Run build
    let buildPassed = true;
    let buildOutput = "";
    if (buildCmd) {
      const buildResult = this.runCommand(buildCmd, timeout);
      buildPassed = buildResult.exitCode === 0;
      buildOutput = buildResult.output;
    } else {
      buildOutput = "(no build command detected)";
    }

    // Run tests
    let testsPassed = true;
    let testOutput = "";
    if (testCmd) {
      const testResult = this.runCommand(testCmd, timeout);
      testsPassed = testResult.exitCode === 0;
      testOutput = testResult.output;
    } else {
      testOutput = "(no test command detected)";
    }

    // Build summary
    const parts: string[] = [];
    if (buildCmd) {
      parts.push(`Build (${buildCmd}): ${buildPassed ? "PASS" : "FAIL"}`);
    }
    if (testCmd) {
      parts.push(`Tests (${testCmd}): ${testsPassed ? "PASS" : "FAIL"}`);
    }
    if (designDoc) {
      parts.push(`Design doc: ${designDoc}`);
    }

    const overall = buildPassed && testsPassed ? "PASS" : "FAIL";
    const summary = `**AutoQA: ${overall}**\n${parts.join("\n")}`;

    return {
      buildPassed,
      buildOutput,
      testsPassed,
      testOutput,
      designDoc: designDoc ?? undefined,
      summary,
    };
  }

  /**
   * Detect the appropriate build command for this project.
   */
  detectBuildCommand(): string | null {
    // Check for TypeScript
    if (existsSync(join(this.baseDir, "tsconfig.json"))) {
      return "npx tsc --noEmit";
    }

    // Check package.json scripts
    const scripts = this.getPackageScripts();
    if (scripts?.build) {
      return "npm run build";
    }

    return null;
  }

  /**
   * Detect the appropriate test command for this project.
   */
  detectTestCommand(): string | null {
    const scripts = this.getPackageScripts();

    // Check for specific test runners
    if (existsSync(join(this.baseDir, "vitest.config.ts")) ||
        existsSync(join(this.baseDir, "vitest.config.js"))) {
      return "npx vitest run";
    }

    if (scripts?.test && scripts.test !== "echo \"Error: no test specified\" && exit 1") {
      return "npm test";
    }

    return null;
  }

  /**
   * Find the most recent design document in docs/plans/.
   */
  detectDesignDoc(): string | null {
    const plansDir = join(this.baseDir, "docs", "plans");
    if (!existsSync(plansDir)) return null;

    try {
      const files = readdirSync(plansDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .reverse(); // most recent first (date-prefixed)

      if (files.length > 0) {
        return join("docs", "plans", files[0]);
      }
    } catch {
      // directory not readable
    }

    return null;
  }

  private getPackageScripts(): Record<string, string> | null {
    const pkgPath = join(this.baseDir, "package.json");
    if (!existsSync(pkgPath)) return null;

    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      return pkg.scripts ?? null;
    } catch {
      return null;
    }
  }

  private runCommand(command: string, timeout: number): { exitCode: number; output: string } {
    try {
      const stdout = execSync(command, {
        cwd: this.baseDir,
        encoding: "utf-8",
        stdio: "pipe",
        timeout,
        maxBuffer: 10 * 1024 * 1024, // 10 MB
      });

      const output = stdout.length > MAX_OUTPUT_LENGTH
        ? stdout.slice(0, MAX_OUTPUT_LENGTH) + "\n... [truncated]"
        : stdout;

      return { exitCode: 0, output };
    } catch (err: any) {
      const stderr = err.stderr ? String(err.stderr) : "";
      const stdout = err.stdout ? String(err.stdout) : "";
      let output = (stdout + "\n" + stderr).trim();

      if (output.length > MAX_OUTPUT_LENGTH) {
        output = output.slice(0, MAX_OUTPUT_LENGTH) + "\n... [truncated]";
      }

      const exitCode = typeof err.status === "number" ? err.status : 1;
      return { exitCode, output };
    }
  }
}
