import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ReviewSession } from "../review.js";
import { DocumentManager } from "@agestra/workspace";
import type { AIProvider, ChatResponse, ProviderCapability, HealthStatus, ChatRequest } from "@agestra/core";

function mockProvider(id: string, response: string): AIProvider {
  return {
    id, type: "mock",
    initialize: async () => {},
    healthCheck: async (): Promise<HealthStatus> => ({ status: "ok" }),
    getCapabilities: (): ProviderCapability => ({
      maxContext: 4096, supportsSystemPrompt: true, supportsFiles: false,
      supportsStreaming: false, supportsJsonOutput: false, supportsToolUse: false,
      strengths: [], models: [],
    }),
    isAvailable: () => true,
    chat: async (req: ChatRequest): Promise<ChatResponse> => ({
      text: response, model: "mock", provider: id,
    }),
  };
}

describe("ReviewSession", () => {
  let dir: string;
  let docManager: DocumentManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "review-test-"));
    docManager = new DocumentManager(dir);
  });

  afterEach(() => { rmSync(dir, { recursive: true }); });

  it("should start review and request reviews from providers", async () => {
    const session = new ReviewSession(docManager);
    const doc = await session.startReview(["src/auth.ts"], ["No hardcoding"]);

    const provider = mockProvider("gemini", "Found 2 issues: hardcoded secret, missing error handling");
    await session.requestReview(doc.id, provider);

    const result = await docManager.read(doc.id);
    expect(result.content).toContain("gemini");
    expect(result.content).toContain("hardcoded");
  });

  it("should support multiple providers reviewing sequentially", async () => {
    const session = new ReviewSession(docManager);
    const doc = await session.startReview(["a.ts"], []);

    await session.requestReview(doc.id, mockProvider("gemini", "Review from Gemini"));
    await session.requestReview(doc.id, mockProvider("codex", "Review from Codex"));

    const result = await docManager.read(doc.id);
    expect(result.content).toContain("Review from Gemini");
    expect(result.content).toContain("Review from Codex");
  });
});
