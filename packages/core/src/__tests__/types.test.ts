import { describe, it, expect } from "vitest";
import type {
  ChatRequest,
  ChatResponse,
  AIProvider,
  ProviderCapability,
  HealthStatus,
} from "../types.js";

describe("Core types", () => {
  it("ChatRequest should accept minimal fields", () => {
    const req: ChatRequest = { prompt: "hello" };
    expect(req.prompt).toBe("hello");
    expect(req.system).toBeUndefined();
  });

  it("ChatResponse should have required fields", () => {
    const res: ChatResponse = {
      text: "world",
      model: "test-model",
      provider: "test-provider",
    };
    expect(res.text).toBe("world");
  });

  it("HealthStatus should accept valid statuses", () => {
    const ok: HealthStatus = { status: "ok" };
    const err: HealthStatus = { status: "error", message: "down" };
    expect(ok.status).toBe("ok");
    expect(err.message).toBe("down");
  });
});
