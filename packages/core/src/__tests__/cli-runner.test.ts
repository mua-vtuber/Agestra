import { describe, it, expect } from "vitest";
import { runCli } from "../cli-runner.js";

describe("CliRunner", () => {
  it("should run a simple command and capture stdout", async () => {
    const result = await runCli({ command: "echo", args: ["hello"] });
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
  });

  it("should capture stderr", async () => {
    const result = await runCli({
      command: "node",
      args: ["-e", "console.error('oops')"],
    });
    expect(result.stderr.trim()).toBe("oops");
    expect(result.exitCode).toBe(0);
  });

  it("should reject on timeout", async () => {
    await expect(
      runCli({ command: "sleep", args: ["10"], timeout: 100 })
    ).rejects.toThrow(/timeout/i);
  });

  it("should report non-zero exit code", async () => {
    const result = await runCli({
      command: "node",
      args: ["-e", "process.exit(42)"],
    });
    expect(result.exitCode).toBe(42);
  });

  it("should set truncated=true when output exceeds maxBuffer", async () => {
    const result = await runCli({
      command: "node",
      args: ["-e", "process.stdout.write('x'.repeat(1024))"],
      maxBuffer: 100,
    });
    expect(result.truncated).toBe(true);
  });

  it("should set truncated=false when output is within maxBuffer", async () => {
    const result = await runCli({
      command: "echo",
      args: ["hello"],
    });
    expect(result.truncated).toBe(false);
  });
});
