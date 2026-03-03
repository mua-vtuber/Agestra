import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { atomicWriteSync, atomicWriteJsonSync, durableAppendSync } from "../atomic-write.js";

describe("atomicWriteSync", () => {
  let tmp: string;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("should write file content", () => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-"));
    const target = join(tmp, "test.txt");
    atomicWriteSync(target, "hello world");
    expect(readFileSync(target, "utf-8")).toBe("hello world");
  });

  it("should overwrite existing file", () => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-"));
    const target = join(tmp, "test.txt");
    atomicWriteSync(target, "first");
    atomicWriteSync(target, "second");
    expect(readFileSync(target, "utf-8")).toBe("second");
  });

  it("should create parent directories", () => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-"));
    const target = join(tmp, "nested", "dir", "test.txt");
    atomicWriteSync(target, "deep");
    expect(readFileSync(target, "utf-8")).toBe("deep");
  });

  it("should not leave temp files on success", () => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-"));
    const target = join(tmp, "test.txt");
    atomicWriteSync(target, "clean");
    const files = require("fs").readdirSync(tmp);
    expect(files).toEqual(["test.txt"]);
  });
});

describe("atomicWriteJsonSync", () => {
  let tmp: string;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("should write JSON with indentation", () => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-json-"));
    const target = join(tmp, "data.json");
    const data = { name: "test", count: 42 };
    atomicWriteJsonSync(target, data);
    const content = readFileSync(target, "utf-8");
    expect(JSON.parse(content)).toEqual(data);
    expect(content).toContain("\n"); // indented
  });

  it("should handle arrays", () => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-json-"));
    const target = join(tmp, "arr.json");
    atomicWriteJsonSync(target, [1, 2, 3]);
    expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual([1, 2, 3]);
  });
});

describe("durableAppendSync", () => {
  let tmp: string;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("should create file and append line", () => {
    tmp = mkdtempSync(join(tmpdir(), "append-"));
    const target = join(tmp, "log.txt");
    durableAppendSync(target, "line1\n");
    expect(readFileSync(target, "utf-8")).toBe("line1\n");
  });

  it("should append multiple lines", () => {
    tmp = mkdtempSync(join(tmpdir(), "append-"));
    const target = join(tmp, "log.txt");
    durableAppendSync(target, "line1\n");
    durableAppendSync(target, "line2\n");
    expect(readFileSync(target, "utf-8")).toBe("line1\nline2\n");
  });

  it("should create parent directories", () => {
    tmp = mkdtempSync(join(tmpdir(), "append-"));
    const target = join(tmp, "sub", "dir", "log.txt");
    durableAppendSync(target, "nested\n");
    expect(existsSync(target)).toBe(true);
  });
});
