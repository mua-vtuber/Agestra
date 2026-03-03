import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodexProvider } from "../provider.js";

// Mock the runCli from core
vi.mock("@agestra/core", async () => {
  const actual = await vi.importActual("@agestra/core");
  return {
    ...(actual as any),
    runCli: vi.fn(),
  };
});

import { runCli } from "@agestra/core";
const mockRunCli = vi.mocked(runCli);

describe("CodexProvider", () => {
  let provider: CodexProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CodexProvider({ id: "codex" });
  });

  it("should report id and type correctly", () => {
    expect(provider.id).toBe("codex");
    expect(provider.type).toBe("codex-cli");
  });

  it("should be unavailable before initialization", () => {
    expect(provider.isAvailable()).toBe(false);
  });

  it("should become available after successful init with direct codex", async () => {
    mockRunCli.mockResolvedValueOnce({ stdout: "0.1.0", stderr: "", exitCode: 0, truncated: false });
    await provider.initialize();
    expect(provider.isAvailable()).toBe(true);
  });

  it("should try npx @openai/codex fallback if direct codex fails", async () => {
    // Direct codex fails
    mockRunCli.mockRejectedValueOnce(new Error("not found"));
    // npx succeeds
    mockRunCli.mockResolvedValueOnce({ stdout: "0.1.0", stderr: "", exitCode: 0, truncated: false });
    await provider.initialize();
    expect(provider.isAvailable()).toBe(true);
    expect(mockRunCli).toHaveBeenCalledTimes(2);
    // Verify npx call used correct package name
    const npxCall = mockRunCli.mock.calls[1][0];
    expect(npxCall.command).toBe("npx");
    expect(npxCall.args).toContain("@openai/codex");
  });

  it("should remain unavailable if both codex and npx fail", async () => {
    mockRunCli.mockRejectedValueOnce(new Error("not found"));
    mockRunCli.mockRejectedValueOnce(new Error("not found"));
    await provider.initialize();
    expect(provider.isAvailable()).toBe(false);
  });

  it("chat should call runCli with exec --full-auto flags and parse JSONL output", async () => {
    // Initialize
    mockRunCli.mockResolvedValueOnce({ stdout: "0.1.0", stderr: "", exitCode: 0, truncated: false });
    await provider.initialize();

    // Chat — Codex exec --json JSONL format
    mockRunCli.mockResolvedValueOnce({
      stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"Hello from Codex"}}',
      stderr: "",
      exitCode: 0,
      truncated: false,
    });
    const res = await provider.chat({ prompt: "write a function" });
    expect(res.text).toBe("Hello from Codex");
    expect(res.provider).toBe("codex");
    expect(res.model).toBe("codex");
  });

  it("chat should pass prompt as positional argument to exec", async () => {
    mockRunCli.mockResolvedValueOnce({ stdout: "0.1.0", stderr: "", exitCode: 0, truncated: false });
    await provider.initialize();

    mockRunCli.mockResolvedValueOnce({
      stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}',
      stderr: "",
      exitCode: 0,
      truncated: false,
    });
    await provider.chat({ prompt: "my prompt" });

    const callArgs = mockRunCli.mock.calls[1][0];
    expect(callArgs.args).toContain("exec");
    expect(callArgs.args).toContain("--full-auto");
    expect(callArgs.args).toContain("--ephemeral");
    expect(callArgs.args).toContain("--json");
    expect(callArgs.args).toContain("my prompt");
  });

  it("chat should include system prompt in the prompt text", async () => {
    mockRunCli.mockResolvedValueOnce({ stdout: "0.1.0", stderr: "", exitCode: 0, truncated: false });
    await provider.initialize();

    mockRunCli.mockResolvedValueOnce({
      stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}',
      stderr: "",
      exitCode: 0,
      truncated: false,
    });
    await provider.chat({
      prompt: "do the task",
      system: "You are a code reviewer.",
    });

    const callArgs = mockRunCli.mock.calls[1][0];
    // Prompt is the last positional arg
    const promptValue = callArgs.args[callArgs.args.length - 1];
    expect(promptValue).toContain("You are a code reviewer.");
    expect(promptValue).toContain("do the task");
  });

  it("should throw ProviderUnavailableError when not initialized", async () => {
    await expect(provider.chat({ prompt: "hi" })).rejects.toThrow(/unavailable/i);
  });

  it("should throw ProviderExecutionError on non-zero exit code", async () => {
    mockRunCli.mockResolvedValueOnce({ stdout: "0.1.0", stderr: "", exitCode: 0, truncated: false });
    await provider.initialize();

    mockRunCli.mockResolvedValueOnce({
      stdout: "",
      stderr: "Error: something failed",
      exitCode: 1,
      truncated: false,
    });
    await expect(provider.chat({ prompt: "hi" })).rejects.toThrow(/execution error/i);
  });

  it("should throw ProviderTimeoutError on timeout", async () => {
    mockRunCli.mockResolvedValueOnce({ stdout: "0.1.0", stderr: "", exitCode: 0, truncated: false });
    await provider.initialize();

    mockRunCli.mockRejectedValueOnce(new Error("CLI timeout after 120000ms"));
    await expect(provider.chat({ prompt: "hi" })).rejects.toThrow(/timeout/i);
  });

  it("getCapabilities should report correct capabilities", () => {
    const caps = provider.getCapabilities();
    expect(caps.supportsJsonOutput).toBe(true);
    expect(caps.supportsFiles).toBe(true);
    expect(caps.supportsToolUse).toBe(true);
    expect(caps.maxContext).toBe(128_000);
    expect(caps.strengths).toContain("code_generation");
  });

  it("healthCheck should return ok when CLI is available", async () => {
    mockRunCli.mockResolvedValueOnce({ stdout: "0.1.0", stderr: "", exitCode: 0, truncated: false });
    await provider.initialize();

    mockRunCli.mockResolvedValueOnce({ stdout: "0.1.0", stderr: "", exitCode: 0, truncated: false });
    const health = await provider.healthCheck();
    expect(health.status).toBe("ok");
  });

  it("healthCheck should return error when not available", async () => {
    const health = await provider.healthCheck();
    expect(health.status).toBe("error");
  });

  it("detects auth error case-insensitively", async () => {
    mockRunCli.mockResolvedValueOnce({ stdout: "0.1.0", stderr: "", exitCode: 0, truncated: false });
    await provider.initialize();

    mockRunCli.mockResolvedValueOnce({
      stdout: "",
      stderr: "Authentication failed",
      exitCode: 1,
      truncated: false,
    });
    await expect(provider.chat({ prompt: "hi" })).rejects.toThrow(/unavailable/i);
  });

  it("detects 429 rate limit and deactivates", async () => {
    mockRunCli.mockResolvedValueOnce({ stdout: "0.1.0", stderr: "", exitCode: 0, truncated: false });
    await provider.initialize();
    expect(provider.isAvailable()).toBe(true);

    mockRunCli.mockResolvedValueOnce({
      stdout: "",
      stderr: "rate limit exceeded",
      exitCode: 1,
      truncated: false,
    });
    await expect(provider.chat({ prompt: "hi" })).rejects.toThrow(/unavailable/i);
    expect(provider.isAvailable()).toBe(false);
  });
});
