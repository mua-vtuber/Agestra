import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { DurableMessageQueue } from "../message-queue.js";

describe("DurableMessageQueue", () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mq-test-")); });
  afterEach(() => { rmSync(dir, { recursive: true }); });

  it("should enqueue and dequeue messages", () => {
    const mq = new DurableMessageQueue(dir);
    mq.send("session1", { from: "gemini", content: "I think X" });
    mq.send("session1", { from: "codex", content: "I disagree" });
    const messages = mq.receive("session1");
    expect(messages).toHaveLength(2);
    expect(messages[0].from).toBe("gemini");
  });

  it("should persist messages to append-only log", () => {
    const mq = new DurableMessageQueue(dir);
    mq.send("s1", { from: "a", content: "msg" });
    const logPath = join(dir, "s1.jsonl");
    const logContent = readFileSync(logPath, "utf-8");
    expect(logContent).toContain('"from":"a"');
  });

  it("should recover session after restart", () => {
    const mq1 = new DurableMessageQueue(dir);
    mq1.send("s1", { from: "a", content: "first" });
    mq1.send("s1", { from: "b", content: "second" });

    // Simulate restart — new instance
    const mq2 = new DurableMessageQueue(dir);
    const recovered = mq2.recover("s1");
    expect(recovered).toHaveLength(2);
    expect(recovered[0].content).toBe("first");
  });

  it("should handle multiple sessions independently", () => {
    const mq = new DurableMessageQueue(dir);
    mq.send("s1", { from: "a", content: "msg1" });
    mq.send("s2", { from: "b", content: "msg2" });
    expect(mq.receive("s1")).toHaveLength(1);
    expect(mq.receive("s2")).toHaveLength(1);
  });

  it("should return empty for unknown session", () => {
    const mq = new DurableMessageQueue(dir);
    expect(mq.receive("nonexistent")).toHaveLength(0);
  });

  it("recover handles partially corrupted JSONL files", () => {
    const logPath = join(dir, "corrupt1.jsonl");
    const lines = [
      JSON.stringify({ from: "a", content: "good1" }),
      "{invalid json}",
      JSON.stringify({ from: "b", content: "good2" }),
    ];
    writeFileSync(logPath, lines.join("\n") + "\n");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mq = new DurableMessageQueue(dir);
    const recovered = mq.recover("corrupt1");

    expect(recovered).toHaveLength(2);
    expect(recovered[0].content).toBe("good1");
    expect(recovered[1].content).toBe("good2");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Skipped 1 corrupted line(s) in session corrupt1")
    );
    warnSpy.mockRestore();
  });

  it("recover returns empty array for fully corrupted file", () => {
    const logPath = join(dir, "corrupt2.jsonl");
    writeFileSync(logPath, "{bad1}\n{bad2}\n{bad3}\n");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mq = new DurableMessageQueue(dir);
    const recovered = mq.recover("corrupt2");

    expect(recovered).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Skipped 3 corrupted line(s) in session corrupt2")
    );
    warnSpy.mockRestore();
  });
});
