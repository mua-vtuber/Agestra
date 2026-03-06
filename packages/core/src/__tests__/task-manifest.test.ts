import { describe, it, expect } from "vitest";
import { generateManifest, validateManifest, type TaskManifest } from "../task-manifest.js";

describe("task-manifest", () => {
  describe("generateManifest", () => {
    it("should generate valid manifest from args", () => {
      const manifest = generateManifest({
        taskDescription: "Refactor auth module",
        workingDir: "/project",
        filesToRead: ["src/auth/login.ts"],
        filesToModify: ["src/auth/session.ts"],
        constraints: "Do not modify public API",
        successCriteria: ["npm test -- src/auth"],
        timeoutMinutes: 10,
      });

      expect(manifest.task).toBe("Refactor auth module");
      expect(manifest.files.readonly).toEqual(["src/auth/login.ts"]);
      expect(manifest.files.readwrite).toEqual(["src/auth/session.ts"]);
      expect(manifest.constraints).toBe("Do not modify public API");
      expect(manifest.success_criteria).toEqual(["npm test -- src/auth"]);
      expect(manifest.timeout_minutes).toBe(10);
      expect(manifest.permissions.allowed_commands).toContain("npm");
    });

    it("should use defaults for optional fields", () => {
      const manifest = generateManifest({
        taskDescription: "Simple task",
        workingDir: "/project",
      });

      expect(manifest.files.readonly).toEqual([]);
      expect(manifest.files.readwrite).toEqual([]);
      expect(manifest.constraints).toBeUndefined();
      expect(manifest.success_criteria).toEqual([]);
      expect(manifest.timeout_minutes).toBe(10);
    });

    it("should set sandbox_root from workingDir", () => {
      const manifest = generateManifest({
        taskDescription: "Task",
        workingDir: "/my/project",
      });
      expect(manifest.permissions.sandbox_root).toBe("/my/project");
    });
  });

  describe("validateManifest", () => {
    const validManifest: TaskManifest = {
      task: "Do something",
      files: { readonly: [], readwrite: [] },
      success_criteria: [],
      permissions: {
        sandbox_root: "/project",
        allowed_commands: ["npm", "node", "git", "tsc"],
      },
      timeout_minutes: 10,
    };

    it("should accept valid manifest", () => {
      const result = validateManifest(validManifest);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should reject empty task", () => {
      const result = validateManifest({ ...validManifest, task: "" });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("task");
    });

    it("should reject missing sandbox_root", () => {
      const result = validateManifest({
        ...validManifest,
        permissions: { ...validManifest.permissions, sandbox_root: "" },
      });
      expect(result.valid).toBe(false);
    });

    it("should reject zero timeout", () => {
      const result = validateManifest({ ...validManifest, timeout_minutes: 0 });
      expect(result.valid).toBe(false);
    });

    it("should reject negative timeout", () => {
      const result = validateManifest({ ...validManifest, timeout_minutes: -5 });
      expect(result.valid).toBe(false);
    });
  });
});
