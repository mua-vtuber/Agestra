import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { createDefaultTools, toOllamaToolDefs } from "../agent-tools.js";
import type { AgentTool } from "../agent-tools.js";

describe("AgentTools", () => {
  let baseDir: string;
  let tools: AgentTool[];
  let toolMap: Map<string, AgentTool>;

  beforeEach(() => {
    baseDir = join(tmpdir(), `agestra-test-${randomUUID().slice(0, 8)}`);
    mkdirSync(baseDir, { recursive: true });
    tools = createDefaultTools();
    toolMap = new Map(tools.map((t) => [t.name, t]));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  describe("createDefaultTools", () => {
    it("returns 5 tools", () => {
      expect(tools).toHaveLength(5);
    });

    it("includes expected tool names", () => {
      const names = tools.map((t) => t.name);
      expect(names).toContain("file_read");
      expect(names).toContain("file_write");
      expect(names).toContain("file_list");
      expect(names).toContain("grep_search");
      expect(names).toContain("shell_exec");
    });
  });

  describe("toOllamaToolDefs", () => {
    it("converts tools to Ollama format", () => {
      const defs = toOllamaToolDefs(tools);
      expect(defs).toHaveLength(5);
      for (const def of defs) {
        expect(def.type).toBe("function");
        expect(def.function.name).toBeTruthy();
        expect(def.function.description).toBeTruthy();
        expect(def.function.parameters.type).toBe("object");
      }
    });

    it("marks required parameters correctly", () => {
      const defs = toOllamaToolDefs(tools);
      const fileRead = defs.find((d) => d.function.name === "file_read")!;
      expect(fileRead.function.parameters.required).toContain("path");
      expect(fileRead.function.parameters.required).not.toContain("offset");
    });
  });

  describe("file_read", () => {
    const tool = () => toolMap.get("file_read")!;

    it("reads a file", async () => {
      writeFileSync(join(baseDir, "hello.txt"), "Hello, world!");
      const result = await tool().execute({ path: "hello.txt" }, baseDir);
      expect(result).toBe("Hello, world!");
    });

    it("supports offset and limit", async () => {
      writeFileSync(join(baseDir, "lines.txt"), "line0\nline1\nline2\nline3\nline4");
      const result = await tool().execute({ path: "lines.txt", offset: 1, limit: 2 }, baseDir);
      expect(result).toBe("line1\nline2");
    });

    it("blocks path traversal", async () => {
      await expect(
        tool().execute({ path: "../../etc/passwd" }, baseDir),
      ).rejects.toThrow("Path traversal blocked");
    });

    it("throws for non-existent file", async () => {
      await expect(
        tool().execute({ path: "nope.txt" }, baseDir),
      ).rejects.toThrow();
    });
  });

  describe("file_write", () => {
    const tool = () => toolMap.get("file_write")!;

    it("writes a file", async () => {
      const result = await tool().execute({ path: "out.txt", content: "data" }, baseDir);
      expect(result).toContain("out.txt");
      const { readFileSync } = await import("fs");
      expect(readFileSync(join(baseDir, "out.txt"), "utf-8")).toBe("data");
    });

    it("creates parent directories", async () => {
      await tool().execute({ path: "sub/dir/file.txt", content: "nested" }, baseDir);
      const { readFileSync } = await import("fs");
      expect(readFileSync(join(baseDir, "sub/dir/file.txt"), "utf-8")).toBe("nested");
    });

    it("blocks path traversal", async () => {
      await expect(
        tool().execute({ path: "../escape.txt", content: "bad" }, baseDir),
      ).rejects.toThrow("Path traversal blocked");
    });
  });

  describe("file_list", () => {
    const tool = () => toolMap.get("file_list")!;

    it("lists directory contents", async () => {
      writeFileSync(join(baseDir, "a.txt"), "");
      writeFileSync(join(baseDir, "b.txt"), "");
      mkdirSync(join(baseDir, "subdir"));

      const result = await tool().execute({ path: "." }, baseDir);
      expect(result).toContain("a.txt");
      expect(result).toContain("b.txt");
      expect(result).toContain("subdir/");
    });

    it("lists recursively", async () => {
      mkdirSync(join(baseDir, "deep"), { recursive: true });
      writeFileSync(join(baseDir, "deep", "inner.txt"), "");

      const result = await tool().execute({ path: ".", recursive: true }, baseDir);
      expect(result).toContain("deep/inner.txt");
    });

    it("blocks path traversal", async () => {
      await expect(
        tool().execute({ path: "../../" }, baseDir),
      ).rejects.toThrow("Path traversal blocked");
    });
  });

  describe("grep_search", () => {
    const tool = () => toolMap.get("grep_search")!;

    it("finds pattern matches", async () => {
      writeFileSync(join(baseDir, "code.ts"), "const foo = 42;\nconst bar = 99;\n");
      const result = await tool().execute({ pattern: "const", path: "." }, baseDir);
      expect(result).toContain("const");
    });

    it("returns no-matches message for unmatched pattern", async () => {
      writeFileSync(join(baseDir, "empty.ts"), "nothing here");
      const result = await tool().execute({ pattern: "zzz_no_match_zzz", path: "." }, baseDir);
      expect(result).toContain("No matches");
    });
  });

  describe("shell_exec", () => {
    const tool = () => toolMap.get("shell_exec")!;

    it("allows safe commands", async () => {
      writeFileSync(join(baseDir, "test.txt"), "hello");
      const result = await tool().execute({ command: "ls" }, baseDir);
      expect(result).toContain("test.txt");
    });

    it("blocks disallowed commands", async () => {
      const result = await tool().execute({ command: "curl http://evil.com" }, baseDir);
      expect(result).toContain("not allowed");
    });

    it("blocks rm command", async () => {
      const result = await tool().execute({ command: "rm -rf /" }, baseDir);
      expect(result).toContain("not allowed");
    });

    it("returns error for empty command", async () => {
      const result = await tool().execute({ command: "" }, baseDir);
      expect(result).toContain("Error");
    });
  });
});
