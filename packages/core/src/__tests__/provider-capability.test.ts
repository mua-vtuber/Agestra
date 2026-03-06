import { describe, it, expect } from "vitest";
import {
  buildCapabilityProfile,
  classifyOllamaComplexity,
} from "../provider-capability.js";
import type { ProviderCapability } from "../types.js";

const baseCap: ProviderCapability = {
  maxContext: 4096,
  supportsSystemPrompt: true,
  supportsFiles: false,
  supportsStreaming: false,
  supportsJsonOutput: false,
  supportsToolUse: false,
  strengths: ["chat"],
  models: [],
};

describe("classifyOllamaComplexity", () => {
  it("should classify small models (< 3GB) as simple", () => {
    expect(classifyOllamaComplexity(2.0)).toBe("simple");
    expect(classifyOllamaComplexity(0.5)).toBe("simple");
  });

  it("should classify medium models (3-8GB) as moderate", () => {
    expect(classifyOllamaComplexity(3.0)).toBe("moderate");
    expect(classifyOllamaComplexity(7.9)).toBe("moderate");
  });

  it("should classify large models (8-20GB) as complex", () => {
    expect(classifyOllamaComplexity(8.0)).toBe("complex");
    expect(classifyOllamaComplexity(14.0)).toBe("complex");
  });

  it("should classify very large models (>20GB) as advanced", () => {
    expect(classifyOllamaComplexity(20.1)).toBe("advanced");
    expect(classifyOllamaComplexity(70.0)).toBe("advanced");
  });
});

describe("buildCapabilityProfile", () => {
  it("should return complex for gemini-cli", () => {
    const profile = buildCapabilityProfile("gemini-cli", baseCap);
    expect(profile.maxComplexity).toBe("complex");
    expect(profile.tier).toBe("agent");
  });

  it("should return complex for codex-cli", () => {
    const profile = buildCapabilityProfile("codex-cli", baseCap);
    expect(profile.maxComplexity).toBe("complex");
    expect(profile.tier).toBe("agent");
  });

  it("should use model size for ollama when provided", () => {
    const profile = buildCapabilityProfile("ollama", baseCap, 14.0);
    expect(profile.maxComplexity).toBe("complex");
  });

  it("should default ollama to simple when no size provided", () => {
    const profile = buildCapabilityProfile("ollama", baseCap);
    expect(profile.maxComplexity).toBe("simple");
  });
});
