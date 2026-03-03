import { describe, it, expect, vi, beforeEach } from "vitest";
import { OllamaProvider } from "../provider.js";

// Mock global fetch for Ollama HTTP API tests
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("OllamaProvider", () => {
  let provider: OllamaProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new OllamaProvider({
      id: "ollama",
      host: "http://localhost:11434",
    });
  });

  it("should report id and type correctly", () => {
    expect(provider.id).toBe("ollama");
    expect(provider.type).toBe("ollama");
  });

  it("should be unavailable before initialization", () => {
    expect(provider.isAvailable()).toBe(false);
  });

  it("healthCheck should call /api/tags", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [{ name: "qwen2.5-coder:7b" }] }),
    });
    const health = await provider.healthCheck();
    expect(health.status).toBe("ok");
  });

  it("healthCheck should return error when server is down", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const health = await provider.healthCheck();
    expect(health.status).toBe("error");
  });

  it("chat should call /api/generate and return ChatResponse", async () => {
    // First make provider available via initialize
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [{ name: "qwen2.5-coder:7b" }] }),
    });
    await provider.initialize();

    // Then test chat
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ response: "hello world", model: "qwen2.5-coder:7b" }),
    });
    const res = await provider.chat({ prompt: "hi" });
    expect(res.text).toBe("hello world");
    expect(res.provider).toBe("ollama");
  });

  it("chat should throw ProviderUnavailableError when not initialized", async () => {
    await expect(provider.chat({ prompt: "hi" })).rejects.toThrow(/unavailable/i);
  });

  it("getCapabilities should include supportsJsonOutput and supportsToolUse", () => {
    const caps = provider.getCapabilities();
    expect(caps.supportsJsonOutput).toBe(false);
    expect(caps.supportsToolUse).toBe(true);
  });

  it("detects 429 rate limit and deactivates", async () => {
    // Initialize provider with a model
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [{ name: "qwen2.5-coder:7b" }] }),
    });
    await provider.initialize();
    expect(provider.isAvailable()).toBe(true);

    // Mock 429 response from /api/generate
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
    });
    await expect(provider.chat({ prompt: "hi" })).rejects.toThrow(/unavailable/i);
    expect(provider.isAvailable()).toBe(false);
  });
});
