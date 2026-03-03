import { describe, it, expect } from "vitest";
import { createLogger } from "../logger.js";

describe("Structured logger", () => {
  it("should include standard fields in log entries", () => {
    const logs: any[] = [];
    const logger = createLogger({ output: (entry) => logs.push(entry) });
    logger.info({ providerId: "ollama", toolName: "ai_chat", latencyMs: 150 }, "call completed");
    expect(logs[0]).toMatchObject({
      level: "info",
      providerId: "ollama",
      toolName: "ai_chat",
      latencyMs: 150,
    });
    expect(logs[0].msg).toBe("call completed");
    expect(logs[0].timestamp).toBeDefined();
  });

  it("should include errorCode on error entries", () => {
    const logs: any[] = [];
    const logger = createLogger({ output: (entry) => logs.push(entry) });
    logger.error({ errorCode: "PROVIDER_TIMEOUT", providerId: "gemini" }, "timeout");
    expect(logs[0].errorCode).toBe("PROVIDER_TIMEOUT");
    expect(logs[0].level).toBe("error");
  });

  it("should default to stderr JSON output", () => {
    // Just test that createLogger() works without custom output
    const logger = createLogger();
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.debug).toBe("function");
  });

  it("respects minLevel option", () => {
    const logs: any[] = [];
    const logger = createLogger({ output: (entry) => logs.push(entry), minLevel: "warn" });
    logger.debug({}, "should be suppressed");
    logger.info({}, "should be suppressed");
    logger.warn({}, "should appear");
    logger.error({}, "should appear");
    expect(logs).toHaveLength(2);
    expect(logs[0].level).toBe("warn");
    expect(logs[1].level).toBe("error");
  });

  it("uses LOG_LEVEL env var as fallback", () => {
    const original = process.env.LOG_LEVEL;
    try {
      process.env.LOG_LEVEL = "error";
      const logs: any[] = [];
      const logger = createLogger({ output: (entry) => logs.push(entry) });
      logger.debug({}, "suppressed");
      logger.info({}, "suppressed");
      logger.warn({}, "suppressed");
      logger.error({}, "visible");
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe("error");
    } finally {
      if (original === undefined) {
        delete process.env.LOG_LEVEL;
      } else {
        process.env.LOG_LEVEL = original;
      }
    }
  });

  it("defaults to debug level when no option or env var", () => {
    const original = process.env.LOG_LEVEL;
    try {
      delete process.env.LOG_LEVEL;
      const logs: any[] = [];
      const logger = createLogger({ output: (entry) => logs.push(entry) });
      logger.debug({}, "debug message");
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe("debug");
    } finally {
      if (original === undefined) {
        delete process.env.LOG_LEVEL;
      } else {
        process.env.LOG_LEVEL = original;
      }
    }
  });
});
