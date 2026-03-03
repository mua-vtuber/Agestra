import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { TaskManager } from "../tasks.js";

describe("TaskManager", () => {
  let dir: string;
  let tm: TaskManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "task-test-"));
    tm = new TaskManager(dir);
  });

  afterEach(() => { rmSync(dir, { recursive: true }); });

  it("should create a task", async () => {
    const task = await tm.create({
      description: "Review auth module",
      provider: "gemini",
      files: ["src/auth.ts"],
    });
    expect(task.id).toBeTruthy();
    expect(task.status).toBe("pending");
  });

  it("should generate full UUID task IDs", async () => {
    const task = await tm.create({ description: "test", provider: "ollama" });
    expect(task.id).toHaveLength(36);
    expect(task.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("should update task status", async () => {
    const task = await tm.create({ description: "test", provider: "ollama" });
    await tm.updateStatus(task.id, "in_progress");
    const updated = await tm.get(task.id);
    expect(updated.status).toBe("in_progress");
  });

  it("should complete a task with result", async () => {
    const task = await tm.create({ description: "test", provider: "ollama" });
    await tm.complete(task.id, "All good, no issues found.");
    const updated = await tm.get(task.id);
    expect(updated.status).toBe("completed");
    expect(updated.result).toContain("All good");
  });

  it("should list tasks", async () => {
    await tm.create({ description: "a", provider: "ollama" });
    await tm.create({ description: "b", provider: "gemini" });
    const tasks = await tm.list();
    expect(tasks).toHaveLength(2);
  });
});
