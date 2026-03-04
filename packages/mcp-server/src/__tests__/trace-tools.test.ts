import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getTools, handleTool } from "../tools/trace.js";
import { TraceWriter } from "@agestra/core";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("Trace MCP tools", () => {
  let dir: string;
  let writer: TraceWriter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trace-tools-"));
    writer = new TraceWriter(dir);

    // Seed data
    writer.write({ traceId: "t1", action: "chat", providerId: "gemini", task: "review", request: { promptSummary: "Review code", fileCount: 2 }, response: { success: true, charLength: 500 }, latencyMs: 3200, quality: { score: 0.8, evaluator: "claude", feedback: "good" }, reasoning: { candidateProviders: ["gemini", "codex"], selectedProvider: "gemini", selectionReason: "Higher quality score", memoryHit: false } });
    writer.write({ traceId: "t1", action: "chat", providerId: "codex", task: "review", request: { promptSummary: "Validate review", fileCount: 2 }, response: { success: true, charLength: 300 }, latencyMs: 5100, quality: { score: 0.7, evaluator: "claude", feedback: "ok" } });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("getTools returns 3 trace tools", () => {
    const tools = getTools();
    expect(tools.map((t) => t.name)).toEqual(["trace_query", "trace_summary", "trace_visualize"]);
  });

  it("trace_query filters by providerId", async () => {
    const result = await handleTool("trace_query", { provider_id: "gemini" }, { traceWriter: writer });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("gemini");
    expect(result.content[0].text).not.toContain("codex");
  });

  it("trace_summary returns quality stats", async () => {
    const result = await handleTool("trace_summary", {}, { traceWriter: writer });
    expect(result.content[0].text).toContain("gemini:review");
    expect(result.content[0].text).toContain("0.8");
  });

  it("trace_visualize generates mermaid for traceId", async () => {
    const result = await handleTool("trace_visualize", { trace_id: "t1" }, { traceWriter: writer });
    expect(result.content[0].text).toContain("graph");
    expect(result.content[0].text).toContain("gemini");
    expect(result.content[0].text).toContain("codex");
  });
});
