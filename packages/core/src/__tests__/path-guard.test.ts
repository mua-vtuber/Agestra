import { describe, it, expect } from "vitest";
import { isPathWithin, safePath, isValidJobId, isAllowedCliCommand } from "../path-guard.js";
import { resolve } from "path";

describe("path-guard", () => {
  describe("isPathWithin", () => {
    it("should accept paths within base directory", () => {
      expect(isPathWithin("src/index.ts", "/project")).toBe(true);
      expect(isPathWithin("./readme.md", "/project")).toBe(true);
    });

    it("should reject paths escaping base directory", () => {
      expect(isPathWithin("../../etc/passwd", "/project")).toBe(false);
      expect(isPathWithin("../secret", "/project")).toBe(false);
    });

    it("should handle absolute paths", () => {
      expect(isPathWithin("/project/src/file.ts", "/project")).toBe(true);
      expect(isPathWithin("/etc/passwd", "/project")).toBe(false);
    });
  });

  describe("safePath", () => {
    const baseDir = "/project";

    it("should resolve safe paths", () => {
      const result = safePath("src/file.ts", baseDir);
      expect(result).toBe(resolve(baseDir, "src/file.ts"));
    });

    it("should throw on path traversal", () => {
      expect(() => safePath("../../etc/passwd", baseDir)).toThrow("Path traversal blocked");
      expect(() => safePath("../secret/key", baseDir)).toThrow("Path traversal blocked");
    });

    it("should throw with descriptive error message", () => {
      expect(() => safePath("../../etc/passwd", baseDir)).toThrow("escapes");
    });
  });

  describe("isValidJobId", () => {
    it("should accept valid job IDs", () => {
      expect(isValidJobId("gemini-1709654321000-a1b2c3")).toBe(true);
      expect(isValidJobId("codex-1709654321000-f0e1d2")).toBe(true);
      expect(isValidJobId("codex-cli-1709654321000-abcdef")).toBe(true);
    });

    it("should reject malicious job IDs with path traversal", () => {
      expect(isValidJobId("../../etc/passwd")).toBe(false);
      expect(isValidJobId("../secret")).toBe(false);
      expect(isValidJobId("..%2f..%2fetc%2fpasswd")).toBe(false);
    });

    it("should reject empty or malformed IDs", () => {
      expect(isValidJobId("")).toBe(false);
      expect(isValidJobId(" ")).toBe(false);
      expect(isValidJobId("no-timestamp")).toBe(false);
      expect(isValidJobId("gemini-notanumber-abcdef")).toBe(false);
    });

    it("should reject IDs with special characters", () => {
      expect(isValidJobId("provider-123-abc;rm -rf /")).toBe(false);
      expect(isValidJobId("provider-123-abc\ninjection")).toBe(false);
    });
  });

  describe("isAllowedCliCommand", () => {
    it("should allow known commands", () => {
      expect(isAllowedCliCommand("gemini")).toBe(true);
      expect(isAllowedCliCommand("codex")).toBe(true);
      expect(isAllowedCliCommand("npx")).toBe(true);
      expect(isAllowedCliCommand("node")).toBe(true);
    });

    it("should reject arbitrary commands", () => {
      expect(isAllowedCliCommand("rm")).toBe(false);
      expect(isAllowedCliCommand("/bin/sh")).toBe(false);
      expect(isAllowedCliCommand("curl")).toBe(false);
      expect(isAllowedCliCommand("")).toBe(false);
    });

    it("should reject path-based commands", () => {
      expect(isAllowedCliCommand("/usr/bin/gemini")).toBe(false);
      expect(isAllowedCliCommand("./malicious")).toBe(false);
    });
  });
});
