import { describe, it, expect } from "vitest";
import { scanForSecrets } from "../secret-scanner.js";

describe("secret-scanner", () => {
  describe("scanForSecrets", () => {
    it("should detect AWS access keys", () => {
      const result = scanForSecrets("Use key AKIAIOSFODNN7EXAMPLE to connect");
      expect(result.clean).toBe(false);
      expect(result.findings.length).toBeGreaterThan(0);
      expect(result.findings[0].type).toBe("aws_access_key");
    });

    it("should detect generic API keys", () => {
      const result = scanForSecrets('api_key = "sk-1234567890abcdef1234567890abcdef"');
      expect(result.clean).toBe(false);
    });

    it("should detect private keys", () => {
      const result = scanForSecrets("-----BEGIN RSA PRIVATE KEY-----");
      expect(result.clean).toBe(false);
      expect(result.findings[0].type).toBe("private_key");
    });

    it("should detect password assignments", () => {
      const result = scanForSecrets('password = "hunter2"');
      expect(result.clean).toBe(false);
      expect(result.findings[0].type).toBe("password_assignment");
    });

    it("should detect bearer tokens", () => {
      const result = scanForSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJ0ZXN0IjoidmFsdWUifQ.abc123");
      expect(result.clean).toBe(false);
    });

    it("should allow environment variable references", () => {
      const result = scanForSecrets("Use $API_KEY for authentication");
      expect(result.clean).toBe(true);
    });

    it("should allow placeholder values", () => {
      const result = scanForSecrets('api_key = "<YOUR_API_KEY>"');
      expect(result.clean).toBe(true);
    });

    it("should return clean for normal code", () => {
      const result = scanForSecrets("function add(a, b) { return a + b; }");
      expect(result.clean).toBe(true);
      expect(result.findings).toHaveLength(0);
    });

    it("should scan multiple strings at once", () => {
      const result = scanForSecrets([
        "normal code here",
        "password = 'secret123'",
        "more normal code",
      ]);
      expect(result.clean).toBe(false);
      expect(result.findings.length).toBeGreaterThan(0);
    });
  });
});
