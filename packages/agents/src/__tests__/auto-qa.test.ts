import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AutoQA } from "../auto-qa.js";

describe("AutoQA", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "agestra-qa-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("detectBuildCommand", () => {
    it("should detect TypeScript projects", () => {
      writeFileSync(join(testDir, "tsconfig.json"), "{}");
      const qa = new AutoQA(testDir);
      expect(qa.detectBuildCommand()).toBe("npx tsc --noEmit");
    });

    it("should detect npm build script", () => {
      writeFileSync(
        join(testDir, "package.json"),
        JSON.stringify({ scripts: { build: "tsc" } }),
      );
      const qa = new AutoQA(testDir);
      expect(qa.detectBuildCommand()).toBe("npm run build");
    });

    it("should return null when no build detected", () => {
      const qa = new AutoQA(testDir);
      expect(qa.detectBuildCommand()).toBeNull();
    });
  });

  describe("detectTestCommand", () => {
    it("should detect vitest config", () => {
      writeFileSync(join(testDir, "vitest.config.ts"), "export default {}");
      const qa = new AutoQA(testDir);
      expect(qa.detectTestCommand()).toBe("npx vitest run");
    });

    it("should detect custom npm test script", () => {
      writeFileSync(
        join(testDir, "package.json"),
        JSON.stringify({ scripts: { test: "jest" } }),
      );
      const qa = new AutoQA(testDir);
      expect(qa.detectTestCommand()).toBe("npm test");
    });

    it("should ignore default npm test script", () => {
      writeFileSync(
        join(testDir, "package.json"),
        JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
      );
      const qa = new AutoQA(testDir);
      expect(qa.detectTestCommand()).toBeNull();
    });
  });

  describe("detectDesignDoc", () => {
    it("should find most recent design doc", () => {
      const plansDir = join(testDir, "docs", "plans");
      mkdirSync(plansDir, { recursive: true });
      writeFileSync(join(plansDir, "2026-01-01-old.md"), "old");
      writeFileSync(join(plansDir, "2026-03-06-new.md"), "new");

      const qa = new AutoQA(testDir);
      const doc = qa.detectDesignDoc();
      expect(doc).toContain("2026-03-06-new.md");
    });

    it("should return null when no plans dir", () => {
      const qa = new AutoQA(testDir);
      expect(qa.detectDesignDoc()).toBeNull();
    });
  });

  describe("run", () => {
    it("should run with explicit commands", async () => {
      const qa = new AutoQA(testDir);
      const result = await qa.run({
        buildCommand: "echo build-ok",
        testCommand: "echo test-ok",
      });

      expect(result.buildPassed).toBe(true);
      expect(result.buildOutput).toContain("build-ok");
      expect(result.testsPassed).toBe(true);
      expect(result.testOutput).toContain("test-ok");
      expect(result.summary).toContain("PASS");
    });

    it("should detect build failure", async () => {
      const qa = new AutoQA(testDir);
      const result = await qa.run({
        buildCommand: "exit 1",
        testCommand: "echo test-ok",
      });

      expect(result.buildPassed).toBe(false);
      expect(result.testsPassed).toBe(true);
      expect(result.summary).toContain("FAIL");
    });

    it("should detect test failure", async () => {
      const qa = new AutoQA(testDir);
      const result = await qa.run({
        buildCommand: "echo ok",
        testCommand: "exit 2",
      });

      expect(result.buildPassed).toBe(true);
      expect(result.testsPassed).toBe(false);
      expect(result.summary).toContain("FAIL");
    });

    it("should handle no commands gracefully", async () => {
      const qa = new AutoQA(testDir);
      const result = await qa.run({});

      expect(result.buildPassed).toBe(true);
      expect(result.testsPassed).toBe(true);
      expect(result.buildOutput).toContain("no build command");
      expect(result.testOutput).toContain("no test command");
    });
  });
});
