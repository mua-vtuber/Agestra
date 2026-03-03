import { describe, it, expect } from "vitest";
import { parseProviderConfig, type ProviderConfig } from "../config-loader.js";

describe("Config loader", () => {
  it("should parse valid config JSON", () => {
    const raw = {
      defaultProvider: "ollama",
      providers: [
        { id: "ollama", type: "ollama", enabled: true, config: { host: "http://localhost:11434" } },
      ],
    };
    const result = parseProviderConfig(raw);
    expect(result.defaultProvider).toBe("ollama");
    expect(result.providers).toHaveLength(1);
  });

  it("should reject config with no providers", () => {
    expect(() => parseProviderConfig({ providers: [] })).toThrow();
  });

  it("should filter disabled providers", () => {
    const raw = {
      providers: [
        { id: "a", type: "t", enabled: true, config: {} },
        { id: "b", type: "t", enabled: false, config: {} },
      ],
    };
    const result = parseProviderConfig(raw);
    expect(result.enabledProviders).toHaveLength(1);
  });

  it("should apply default executionPolicy as read-only", () => {
    const raw = {
      providers: [
        { id: "a", type: "t", enabled: true, config: {} },
      ],
    };
    const result = parseProviderConfig(raw);
    expect(result.providers[0].executionPolicy).toBe("read-only");
  });

  it("should apply default selectionPolicy as default-only", () => {
    const raw = {
      providers: [
        { id: "a", type: "t", enabled: true, config: {} },
      ],
    };
    const result = parseProviderConfig(raw);
    expect(result.selectionPolicy).toBe("default-only");
  });
});
