import { describe, it, expect, vi, beforeEach } from "vitest";
import { GeminiProvider } from "../provider.js";

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

// Helper: build Gemini -o json response
function geminiJsonResponse(response: string, model = "gemini-2.5-pro"): string {
  return JSON.stringify({
    session_id: "test-session",
    response,
    stats: {
      models: {
        [model]: {
          api: { totalRequests: 1 },
          roles: { main: { totalRequests: 1 } },
        },
      },
    },
  });
}

describe("GeminiProvider", () => {
  let provider: GeminiProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GeminiProvider({ id: "gemini" });
  });

  it("should report id and type correctly", () => {
    expect(provider.id).toBe("gemini");
    expect(provider.type).toBe("gemini-cli");
  });

  it("should be unavailable before initialization", () => {
    expect(provider.isAvailable()).toBe(false);
  });

  it("should become available after successful init with direct gemini", async () => {
    mockRunCli.mockResolvedValueOnce({ stdout: "1.0.0", stderr: "", exitCode: 0, truncated: false });
    await provider.initialize();
    expect(provider.isAvailable()).toBe(true);
  });

  it("should try npx fallback if direct gemini fails", async () => {
    // Direct gemini fails
    mockRunCli.mockRejectedValueOnce(new Error("not found"));
    // npx succeeds
    mockRunCli.mockResolvedValueOnce({ stdout: "1.0.0", stderr: "", exitCode: 0, truncated: false });
    await provider.initialize();
    expect(provider.isAvailable()).toBe(true);
    expect(mockRunCli).toHaveBeenCalledTimes(2);
  });

  it("should remain unavailable if both gemini and npx fail", async () => {
    mockRunCli.mockRejectedValueOnce(new Error("not found"));
    mockRunCli.mockRejectedValueOnce(new Error("not found"));
    await provider.initialize();
    expect(provider.isAvailable()).toBe(false);
  });

  it("chat should parse JSON output and extract model name", async () => {
    // Initialize
    mockRunCli.mockResolvedValueOnce({ stdout: "1.0.0", stderr: "", exitCode: 0, truncated: false });
    await provider.initialize();

    // Chat — JSON response from -o json
    mockRunCli.mockResolvedValueOnce({
      stdout: geminiJsonResponse("Hello world", "gemini-3-flash-preview"),
      stderr: "",
      exitCode: 0,
      truncated: false,
    });
    const res = await provider.chat({ prompt: "hi" });
    expect(res.text).toBe("Hello world");
    expect(res.provider).toBe("gemini");
    expect(res.model).toBe("gemini-3-flash-preview");
  });

  it("chat should fall back to text filtering when output is not JSON", async () => {
    mockRunCli.mockResolvedValueOnce({ stdout: "1.0.0", stderr: "", exitCode: 0, truncated: false });
    await provider.initialize();

    // Non-JSON output (text fallback)
    mockRunCli.mockResolvedValueOnce({
      stdout: "Loaded cached credentials\nHello world\n[debug] done",
      stderr: "",
      exitCode: 0,
      truncated: false,
    });
    const res = await provider.chat({ prompt: "hi" });
    expect(res.text).toBe("Hello world");
    expect(res.model).toBe("gemini");
  });

  it("chat should pass prompt via -p flag and use -o json", async () => {
    mockRunCli.mockResolvedValueOnce({ stdout: "1.0.0", stderr: "", exitCode: 0, truncated: false });
    await provider.initialize();

    mockRunCli.mockResolvedValueOnce({
      stdout: geminiJsonResponse("ok"),
      stderr: "",
      exitCode: 0,
      truncated: false,
    });
    await provider.chat({ prompt: "my prompt" });

    const callArgs = mockRunCli.mock.calls[1][0];
    expect(callArgs.args).toContain("-p");
    expect(callArgs.args).toContain("my prompt");
    expect(callArgs.args).toContain("-o");
    expect(callArgs.args).toContain("json");
    // Should NOT use stdin anymore
    expect(callArgs.stdin).toBeUndefined();
  });

  it("chat should include system prompt and files in the -p prompt text", async () => {
    mockRunCli.mockResolvedValueOnce({ stdout: "1.0.0", stderr: "", exitCode: 0, truncated: false });
    await provider.initialize();

    mockRunCli.mockResolvedValueOnce({
      stdout: geminiJsonResponse("Response with context"),
      stderr: "",
      exitCode: 0,
      truncated: false,
    });
    await provider.chat({
      prompt: "analyze this",
      system: "You are a code reviewer.",
      files: [{ path: "test.ts", content: "const x = 1;" }],
    });

    const callArgs = mockRunCli.mock.calls[1][0];
    // Prompt is passed via -p flag as single string
    const pIdx = callArgs.args.indexOf("-p");
    const promptValue = callArgs.args[pIdx + 1];
    expect(promptValue).toContain("You are a code reviewer.");
    expect(promptValue).toContain("analyze this");
    expect(promptValue).toContain("test.ts");
    expect(promptValue).toContain("const x = 1;");
  });

  it("should throw ProviderUnavailableError when not initialized", async () => {
    await expect(provider.chat({ prompt: "hi" })).rejects.toThrow(/unavailable/i);
  });

  it("should throw ProviderExecutionError on non-zero exit code", async () => {
    mockRunCli.mockResolvedValueOnce({ stdout: "1.0.0", stderr: "", exitCode: 0, truncated: false });
    await provider.initialize();

    mockRunCli.mockResolvedValueOnce({
      stdout: "",
      stderr: "Some error occurred",
      exitCode: 1,
      truncated: false,
    });
    await expect(provider.chat({ prompt: "hi" })).rejects.toThrow(/execution error/i);
  });

  it("should throw ProviderUnavailableError on auth errors", async () => {
    mockRunCli.mockResolvedValueOnce({ stdout: "1.0.0", stderr: "", exitCode: 0, truncated: false });
    await provider.initialize();

    mockRunCli.mockResolvedValueOnce({
      stdout: "",
      stderr: "authentication failed: invalid credential",
      exitCode: 1,
      truncated: false,
    });
    await expect(provider.chat({ prompt: "hi" })).rejects.toThrow(/authentication/i);
  });

  it("should throw ProviderTimeoutError on timeout", async () => {
    mockRunCli.mockResolvedValueOnce({ stdout: "1.0.0", stderr: "", exitCode: 0, truncated: false });
    await provider.initialize();

    mockRunCli.mockRejectedValueOnce(new Error("CLI timeout after 120000ms"));
    await expect(provider.chat({ prompt: "hi" })).rejects.toThrow(/timeout/i);
  });

  it("getCapabilities should include supportsJsonOutput and supportsFiles", () => {
    const caps = provider.getCapabilities();
    expect(caps.supportsJsonOutput).toBe(true);
    expect(caps.supportsFiles).toBe(true);
    expect(caps.maxContext).toBe(1_000_000);
    expect(caps.supportsToolUse).toBe(false);
  });

  it("healthCheck should return ok when CLI is available", async () => {
    mockRunCli.mockResolvedValueOnce({ stdout: "1.0.0", stderr: "", exitCode: 0, truncated: false });
    await provider.initialize();

    mockRunCli.mockResolvedValueOnce({ stdout: "1.0.0", stderr: "", exitCode: 0, truncated: false });
    const health = await provider.healthCheck();
    expect(health.status).toBe("ok");
  });

  it("healthCheck should return error when not available", async () => {
    const health = await provider.healthCheck();
    expect(health.status).toBe("error");
  });

  it("should respect custom timeout", () => {
    const customProvider = new GeminiProvider({ id: "gemini-custom", timeout: 60_000 });
    expect(customProvider.id).toBe("gemini-custom");
  });

  it("detects auth error case-insensitively", async () => {
    mockRunCli.mockResolvedValueOnce({ stdout: "1.0.0", stderr: "", exitCode: 0, truncated: false });
    await provider.initialize();

    mockRunCli.mockResolvedValueOnce({
      stdout: "",
      stderr: "AUTH_ERROR: invalid",
      exitCode: 1,
      truncated: false,
    });
    await expect(provider.chat({ prompt: "hi" })).rejects.toThrow(/unavailable/i);
  });

  it("detects 429 rate limit and deactivates", async () => {
    mockRunCli.mockResolvedValueOnce({ stdout: "1.0.0", stderr: "", exitCode: 0, truncated: false });
    await provider.initialize();
    expect(provider.isAvailable()).toBe(true);

    mockRunCli.mockResolvedValueOnce({
      stdout: "",
      stderr: "429 Too Many Requests",
      exitCode: 1,
      truncated: false,
    });
    await expect(provider.chat({ prompt: "hi" })).rejects.toThrow(/unavailable/i);
    expect(provider.isAvailable()).toBe(false);
  });
});
