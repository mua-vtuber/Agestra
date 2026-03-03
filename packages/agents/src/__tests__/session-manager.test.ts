import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SessionManager } from "../session-manager.js";

describe("SessionManager", () => {
  let dir: string;
  let sm: SessionManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-test-"));
    sm = new SessionManager(dir);
  });

  afterEach(() => { rmSync(dir, { recursive: true }); });

  it("should create a debate session", () => {
    const session = sm.createSession("debate", { topic: "React vs Vue" });
    expect(session.id).toBeTruthy();
    expect(session.type).toBe("debate");
    expect(session.status).toBe("pending");
  });

  it("should generate full UUID session IDs", () => {
    const session = sm.createSession("debate", { topic: "test" });
    expect(session.id).toHaveLength(36);
    expect(session.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("should list sessions", () => {
    sm.createSession("debate", { topic: "test" });
    sm.createSession("review", { files: ["a.ts"] });
    const sessions = sm.listSessions();
    expect(sessions).toHaveLength(2);
  });

  it("should update session status", () => {
    const session = sm.createSession("task", { description: "test" });
    sm.updateSessionStatus(session.id, "in_progress");
    const updated = sm.getSession(session.id);
    expect(updated?.status).toBe("in_progress");
  });

  it("should complete a session", () => {
    const session = sm.createSession("debate", { topic: "test" });
    sm.completeSession(session.id, "Consensus reached");
    const updated = sm.getSession(session.id);
    expect(updated?.status).toBe("completed");
    expect(updated?.result).toBe("Consensus reached");
  });
});
