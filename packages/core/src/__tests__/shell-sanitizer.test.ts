import { describe, it, expect } from "vitest";
import {
  validateShellCommand,
  escapeShellArg,
  SAFE_SHELL_COMMANDS,
  BLOCKED_COMMANDS,
  SHELL_META_CHARS,
} from "../shell-sanitizer.js";

describe("shell-sanitizer", () => {
  describe("SAFE_SHELL_COMMANDS", () => {
    it("should include expected safe commands", () => {
      expect(SAFE_SHELL_COMMANDS.has("ls")).toBe(true);
      expect(SAFE_SHELL_COMMANDS.has("cat")).toBe(true);
      expect(SAFE_SHELL_COMMANDS.has("grep")).toBe(true);
      expect(SAFE_SHELL_COMMANDS.has("find")).toBe(true);
      expect(SAFE_SHELL_COMMANDS.has("sort")).toBe(true);
      expect(SAFE_SHELL_COMMANDS.has("uniq")).toBe(true);
    });

    it("should not include interpreters", () => {
      expect(SAFE_SHELL_COMMANDS.has("node")).toBe(false);
      expect(SAFE_SHELL_COMMANDS.has("npm")).toBe(false);
      expect(SAFE_SHELL_COMMANDS.has("python")).toBe(false);
    });
  });

  describe("BLOCKED_COMMANDS", () => {
    it("should block destructive commands", () => {
      expect(BLOCKED_COMMANDS.has("rm")).toBe(true);
      expect(BLOCKED_COMMANDS.has("sudo")).toBe(true);
      expect(BLOCKED_COMMANDS.has("chmod")).toBe(true);
      expect(BLOCKED_COMMANDS.has("dd")).toBe(true);
    });

    it("should block interpreters", () => {
      expect(BLOCKED_COMMANDS.has("node")).toBe(true);
      expect(BLOCKED_COMMANDS.has("npm")).toBe(true);
      expect(BLOCKED_COMMANDS.has("python")).toBe(true);
      expect(BLOCKED_COMMANDS.has("perl")).toBe(true);
      expect(BLOCKED_COMMANDS.has("ruby")).toBe(true);
    });

    it("should block shell invocations", () => {
      expect(BLOCKED_COMMANDS.has("sh")).toBe(true);
      expect(BLOCKED_COMMANDS.has("bash")).toBe(true);
      expect(BLOCKED_COMMANDS.has("zsh")).toBe(true);
      expect(BLOCKED_COMMANDS.has("eval")).toBe(true);
      expect(BLOCKED_COMMANDS.has("exec")).toBe(true);
    });
  });

  describe("SHELL_META_CHARS", () => {
    it("should match pipe", () => {
      expect(SHELL_META_CHARS.test("|")).toBe(true);
    });

    it("should match semicolon", () => {
      expect(SHELL_META_CHARS.test(";")).toBe(true);
    });

    it("should match ampersand", () => {
      expect(SHELL_META_CHARS.test("&")).toBe(true);
    });

    it("should match backtick", () => {
      expect(SHELL_META_CHARS.test("`")).toBe(true);
    });

    it("should match dollar sign", () => {
      expect(SHELL_META_CHARS.test("$")).toBe(true);
    });

    it("should match parentheses", () => {
      expect(SHELL_META_CHARS.test("(")).toBe(true);
      expect(SHELL_META_CHARS.test(")")).toBe(true);
    });

    it("should not match safe characters", () => {
      expect(SHELL_META_CHARS.test("a")).toBe(false);
      expect(SHELL_META_CHARS.test("/")).toBe(false);
      expect(SHELL_META_CHARS.test(".")).toBe(false);
      expect(SHELL_META_CHARS.test("-")).toBe(false);
      expect(SHELL_META_CHARS.test("_")).toBe(false);
    });
  });

  describe("validateShellCommand", () => {
    it("should accept simple safe commands", () => {
      expect(validateShellCommand("ls")).toEqual({ valid: true });
      expect(validateShellCommand("ls -la")).toEqual({ valid: true });
      expect(validateShellCommand("cat file.txt")).toEqual({ valid: true });
      expect(validateShellCommand("grep pattern file.txt")).toEqual({ valid: true });
      expect(validateShellCommand("find . -name foo")).toEqual({ valid: true });
    });

    it("should reject shell metacharacters", () => {
      const result1 = validateShellCommand("ls; rm -rf /");
      expect(result1.valid).toBe(false);
      expect(result1.error).toContain("metacharacters");

      const result2 = validateShellCommand("ls | grep foo");
      expect(result2.valid).toBe(false);

      const result3 = validateShellCommand("ls && echo hacked");
      expect(result3.valid).toBe(false);

      const result4 = validateShellCommand("echo `whoami`");
      expect(result4.valid).toBe(false);

      const result5 = validateShellCommand("echo $(whoami)");
      expect(result5.valid).toBe(false);
    });

    it("should reject disallowed commands", () => {
      const result = validateShellCommand("curl http://evil.com");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("not allowed");
    });

    it("should reject rm command", () => {
      const result = validateShellCommand("rm file.txt");
      expect(result.valid).toBe(false);
    });

    it("should reject node interpreter", () => {
      const result = validateShellCommand("node -e 'process.exit(1)'");
      expect(result.valid).toBe(false);
    });

    it("should reject npm", () => {
      const result = validateShellCommand("npm run malicious");
      expect(result.valid).toBe(false);
    });

    it("should reject empty command", () => {
      const result = validateShellCommand("  ");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Empty");
    });

    it("should strip path prefix from command", () => {
      const result = validateShellCommand("/usr/bin/ls -la");
      expect(result.valid).toBe(true);
    });

    it("should reject chained commands without spaces (ls;rm)", () => {
      // Semicolon is a metacharacter and is caught in stage 1
      const result = validateShellCommand("ls;rm");
      expect(result.valid).toBe(false);
    });

    it("should reject newlines (multiline injection)", () => {
      const result = validateShellCommand("ls\nrm -rf /");
      expect(result.valid).toBe(false);
    });
  });

  describe("escapeShellArg", () => {
    it("should escape double quotes", () => {
      expect(escapeShellArg('say "hello"')).toBe('say \\"hello\\"');
    });

    it("should escape dollar signs", () => {
      expect(escapeShellArg("price is $10")).toBe("price is \\$10");
    });

    it("should escape backticks", () => {
      expect(escapeShellArg("run `cmd`")).toBe("run \\`cmd\\`");
    });

    it("should escape backslashes", () => {
      expect(escapeShellArg("path\\to")).toBe("path\\\\to");
    });

    it("should leave safe strings unchanged", () => {
      expect(escapeShellArg("hello world")).toBe("hello world");
    });
  });
});
