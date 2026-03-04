import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { TraceWriter } from "../trace.js";
import type { TraceRecord } from "../trace.js";

function makeRecord(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    traceId: "trace-001",
    action: "chat",
    providerId: "ollama",
    task: "code_review",
    request: { promptSummary: "Review this function", fileCount: 1 },
    response: { success: true, charLength: 500 },
    latencyMs: 1200,
    ...overrides,
  };
}

describe("TraceWriter", () => {
  let tmp: string;
  let writer: TraceWriter;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "trace-test-"));
    writer = new TraceWriter(tmp);
  });

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  // ── Test 1: writes a trace record to dated JSONL file ──────────────

  it("writes a trace record to a dated JSONL file", () => {
    const timestamp = "2026-03-04T10:00:00.000Z";
    writer.write(makeRecord({ timestamp }));

    const filePath = join(tmp, ".agestra", "traces", "2026-03-04.jsonl");
    const content = readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.traceId).toBe("trace-001");
    expect(parsed.action).toBe("chat");
    expect(parsed.providerId).toBe("ollama");
    expect(parsed.timestamp).toBe(timestamp);
  });

  // ── Test 2: appends multiple records to same file ──────────────────

  it("appends multiple records to the same file", () => {
    const timestamp = "2026-03-04T10:00:00.000Z";
    writer.write(makeRecord({ traceId: "t1", timestamp }));
    writer.write(makeRecord({ traceId: "t2", timestamp }));
    writer.write(makeRecord({ traceId: "t3", timestamp }));

    const filePath = join(tmp, ".agestra", "traces", "2026-03-04.jsonl");
    const lines = readFileSync(filePath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).traceId).toBe("t1");
    expect(JSON.parse(lines[1]).traceId).toBe("t2");
    expect(JSON.parse(lines[2]).traceId).toBe("t3");
  });

  // ── Test 3: reads traces with filtering ────────────────────────────

  it("filters traces by providerId", () => {
    const timestamp = "2026-03-04T12:00:00.000Z";
    writer.write(makeRecord({ traceId: "t1", providerId: "ollama", timestamp }));
    writer.write(makeRecord({ traceId: "t2", providerId: "gemini", timestamp }));
    writer.write(makeRecord({ traceId: "t3", providerId: "ollama", timestamp }));

    const results = writer.query({ providerId: "ollama" });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.providerId === "ollama")).toBe(true);
  });

  it("filters traces by failedOnly", () => {
    const timestamp = "2026-03-04T12:00:00.000Z";
    writer.write(
      makeRecord({
        traceId: "t1",
        response: { success: true, charLength: 100 },
        timestamp,
      }),
    );
    writer.write(
      makeRecord({
        traceId: "t2",
        response: { success: false, charLength: 0, error: "timeout" },
        timestamp,
      }),
    );

    const failed = writer.query({ failedOnly: true });
    expect(failed).toHaveLength(1);
    expect(failed[0].traceId).toBe("t2");
    expect(failed[0].response.error).toBe("timeout");
  });

  it("filters traces by successOnly", () => {
    const timestamp = "2026-03-04T12:00:00.000Z";
    writer.write(
      makeRecord({
        traceId: "t1",
        response: { success: true, charLength: 100 },
        timestamp,
      }),
    );
    writer.write(
      makeRecord({
        traceId: "t2",
        response: { success: false, charLength: 0, error: "fail" },
        timestamp,
      }),
    );

    const ok = writer.query({ successOnly: true });
    expect(ok).toHaveLength(1);
    expect(ok[0].traceId).toBe("t1");
  });

  it("filters traces by task", () => {
    const timestamp = "2026-03-04T12:00:00.000Z";
    writer.write(makeRecord({ traceId: "t1", task: "code_review", timestamp }));
    writer.write(makeRecord({ traceId: "t2", task: "refactor", timestamp }));

    const results = writer.query({ task: "refactor" });
    expect(results).toHaveLength(1);
    expect(results[0].task).toBe("refactor");
  });

  it("filters traces by traceId", () => {
    const timestamp = "2026-03-04T12:00:00.000Z";
    writer.write(makeRecord({ traceId: "t1", timestamp }));
    writer.write(makeRecord({ traceId: "t2", timestamp }));

    const results = writer.query({ traceId: "t2" });
    expect(results).toHaveLength(1);
    expect(results[0].traceId).toBe("t2");
  });

  it("respects limit option", () => {
    const timestamp = "2026-03-04T12:00:00.000Z";
    for (let i = 0; i < 10; i++) {
      writer.write(makeRecord({ traceId: `t${i}`, timestamp }));
    }

    const results = writer.query({ limit: 3 });
    expect(results).toHaveLength(3);
  });

  // ── Test 4: computes quality stats per provider and task ───────────

  it("computes quality stats per provider and task", () => {
    const timestamp = "2026-03-04T12:00:00.000Z";

    // Ollama code_review: 2 records with quality
    writer.write(
      makeRecord({
        traceId: "t1",
        providerId: "ollama",
        task: "code_review",
        latencyMs: 1000,
        quality: { score: 8, evaluator: "claude", feedback: "good" },
        timestamp,
      }),
    );
    writer.write(
      makeRecord({
        traceId: "t2",
        providerId: "ollama",
        task: "code_review",
        latencyMs: 2000,
        quality: { score: 6, evaluator: "claude", feedback: "ok" },
        timestamp,
      }),
    );

    // Gemini refactor: 1 record with quality
    writer.write(
      makeRecord({
        traceId: "t3",
        providerId: "gemini",
        task: "refactor",
        latencyMs: 3000,
        quality: { score: 9, evaluator: "claude", feedback: "excellent" },
        timestamp,
      }),
    );

    // Record without quality — should not appear in stats
    writer.write(
      makeRecord({
        traceId: "t4",
        providerId: "ollama",
        task: "code_review",
        latencyMs: 500,
        timestamp,
      }),
    );

    const stats = writer.getQualityStats(7);

    expect(stats.size).toBe(2);

    const ollamaReview = stats.get("ollama:code_review")!;
    expect(ollamaReview.count).toBe(2);
    expect(ollamaReview.avgScore).toBe(7); // (8+6)/2
    expect(ollamaReview.avgLatencyMs).toBe(1500); // (1000+2000)/2

    const geminiRefactor = stats.get("gemini:refactor")!;
    expect(geminiRefactor.count).toBe(1);
    expect(geminiRefactor.avgScore).toBe(9);
    expect(geminiRefactor.avgLatencyMs).toBe(3000);
  });

  // ── Test 5: cleans up old files ────────────────────────────────────

  it("cleans up files older than retention days", () => {
    const tracesDir = join(tmp, ".agestra", "traces");

    // Create old file (30 days ago)
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 30);
    const oldDateStr = formatDateHelper(oldDate);
    writeFileSync(
      join(tracesDir, `${oldDateStr}.jsonl`),
      JSON.stringify(makeRecord()) + "\n",
    );

    // Create recent file (today)
    const todayStr = formatDateHelper(new Date());
    writeFileSync(
      join(tracesDir, `${todayStr}.jsonl`),
      JSON.stringify(makeRecord()) + "\n",
    );

    const deleted = writer.cleanup(7);
    expect(deleted).toBe(1);

    // Today's file should remain
    const remaining = writer.query();
    expect(remaining.length).toBeGreaterThanOrEqual(1);
  });

  // ── Test 6: updateQuality merges into parent trace on query ────────

  it("updateQuality merges quality into parent trace on query", () => {
    const timestamp = "2026-03-04T12:00:00.000Z";

    // Write a trace without quality
    writer.write(
      makeRecord({
        traceId: "trace-x",
        providerId: "ollama",
        timestamp,
      }),
    );

    // Later, update quality for that trace
    writer.updateQuality("trace-x", "ollama", {
      score: 9,
      evaluator: "gemini",
      feedback: "Very thorough review",
    });

    // Query should merge quality into parent
    const results = writer.query({ traceId: "trace-x" });
    expect(results).toHaveLength(1);
    expect(results[0].quality).toBeDefined();
    expect(results[0].quality!.score).toBe(9);
    expect(results[0].quality!.evaluator).toBe("gemini");
    expect(results[0].quality!.feedback).toBe("Very thorough review");
  });

  it("auto-fills timestamp when not provided", () => {
    writer.write(makeRecord({ traceId: "auto-ts" }));

    const results = writer.query({ traceId: "auto-ts" });
    expect(results).toHaveLength(1);
    expect(results[0].timestamp).toBeDefined();
    // Should be a valid ISO timestamp
    expect(new Date(results[0].timestamp!).getTime()).not.toBeNaN();
  });

  it("creates the traces directory on construction", () => {
    const freshDir = mkdtempSync(join(tmpdir(), "trace-fresh-"));
    try {
      new TraceWriter(freshDir);
      // Should not throw; directory is created
      const { existsSync } = require("fs");
      expect(existsSync(join(freshDir, ".agestra", "traces"))).toBe(true);
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  });
});

// Helper to format date as YYYY-MM-DD
function formatDateHelper(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
