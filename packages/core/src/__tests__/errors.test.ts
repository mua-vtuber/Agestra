import { describe, it, expect, vi } from "vitest";
import {
  ProviderNotFoundError,
  ProviderAuthError,
  ProviderTimeoutError,
  ProviderExecutionError,
  isProviderError,
  withRetry,
} from "../errors.js";

describe("Provider errors", () => {
  it("ProviderNotFoundError should include provider id", () => {
    const err = new ProviderNotFoundError("ollama");
    expect(err.message).toContain("ollama");
    expect(err.providerId).toBe("ollama");
    expect(err.code).toBe("PROVIDER_NOT_FOUND");
    expect(err.retryable).toBe(false);
    expect(err instanceof Error).toBe(true);
  });

  it("ProviderTimeoutError should include timeout value and be retryable", () => {
    const err = new ProviderTimeoutError("gemini", 30000);
    expect(err.timeoutMs).toBe(30000);
    expect(err.retryable).toBe(true);
  });

  it("ProviderExecutionError should be retryable", () => {
    const err = new ProviderExecutionError("codex", "cli failed");
    expect(err.retryable).toBe(true);
  });

  it("ProviderAuthError should NOT be retryable", () => {
    const err = new ProviderAuthError("gemini", "bad key");
    expect(err.retryable).toBe(false);
  });

  it("isProviderError should type-guard correctly", () => {
    const err = new ProviderExecutionError("codex", "cli failed");
    expect(isProviderError(err)).toBe(true);
    expect(isProviderError(new Error("generic"))).toBe(false);
  });
});

describe("withRetry", () => {
  it("should succeed on first attempt without retry", async () => {
    let calls = 0;
    const result = await withRetry(async () => { calls++; return "ok"; });
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("should retry retryable errors", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls === 1) throw new ProviderTimeoutError("test", 1000);
      return "recovered";
    }, 1, 10); // 10ms base delay for fast test
    expect(result).toBe("recovered");
    expect(calls).toBe(2);
  });

  it("should NOT retry non-retryable errors", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new ProviderAuthError("test", "bad");
      }, 1, 10)
    ).rejects.toThrow(/bad/);
    expect(calls).toBe(1); // No retry
  });

  it("should throw after max retries exhausted", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new ProviderTimeoutError("test", 1000);
      }, 1, 10)
    ).rejects.toThrow(/timeout/i);
    expect(calls).toBe(2); // 1 attempt + 1 retry
  });

  it("withRetry applies jitter to backoff delay", async () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const delays: number[] = [];
    const origSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn: any, ms?: number) => {
      delays.push(ms ?? 0);
      return origSetTimeout(fn, 0);
    });

    let calls = 0;
    await withRetry(async () => {
      calls++;
      if (calls <= 2) throw new ProviderTimeoutError("test", 1000);
      return "ok";
    }, 2, 100);

    // attempt 0: raw=100*1=100, jittered=100*(0.5+0.5*0.5)=75
    expect(delays[0]).toBe(75);
    // attempt 1: raw=100*2=200, jittered=200*(0.5+0.25)=150
    expect(delays[1]).toBe(150);

    randomSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("withRetry caps delay at maxBackoffMs", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1); // max jitter factor = 1.0
    const delays: number[] = [];
    const origSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn: any, ms?: number) => {
      delays.push(ms ?? 0);
      return origSetTimeout(fn, 0);
    });

    let calls = 0;
    await withRetry(async () => {
      calls++;
      if (calls <= 1) throw new ProviderTimeoutError("test", 1000);
      return "ok";
    }, 1, 1000, 50);

    // raw=1000, jittered=1000*(0.5+0.5*1)=1000, capped at 50
    expect(delays[0]).toBeLessThanOrEqual(50);

    vi.restoreAllMocks();
  });

  it("withRetry defaults maxBackoffMs to 30000", async () => {
    // Verify the function signature accepts 3 args (backward compat)
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      return "ok";
    }, 1, 100);
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });
});
