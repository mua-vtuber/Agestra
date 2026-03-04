# Observability + Benchmark + Memory Tiering Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add integrated trace recording, quality benchmarking, semantic tracing with Mermaid visualization, and memory tiering to Agestra.

**Architecture:** All provider interactions are traced via a central TraceWriter (JSONL). Quality scores are embedded into existing aggregation/debate flows (zero extra cost). Semantic reasoning is recorded at provider selection time. Memory gets an L1 session cache layer before existing hybrid search.

**Tech Stack:** TypeScript, Vitest, JSONL files, existing sql.js/WASM SQLite, Mermaid markdown

---

### Task 1: TraceRecord type + TraceWriter

**Files:**
- Create: `packages/core/src/trace.ts`
- Modify: `packages/core/src/index.ts` (add export)
- Test: `packages/core/src/__tests__/trace.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/core/src/__tests__/trace.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TraceWriter } from "../trace.js";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("TraceWriter", () => {
  let dir: string;
  let writer: TraceWriter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trace-test-"));
    writer = new TraceWriter(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a trace record to dated JSONL file", () => {
    writer.write({
      traceId: "test-1",
      action: "chat",
      providerId: "gemini",
      task: "code-review",
      request: { promptSummary: "Review this code", fileCount: 1 },
      response: { success: true, charLength: 500 },
      latencyMs: 3200,
    });

    const files = readdirSync(dir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/);

    const content = readFileSync(join(dir, files[0]), "utf-8");
    const record = JSON.parse(content.trim());
    expect(record.traceId).toBe("test-1");
    expect(record.timestamp).toBeDefined();
    expect(record.response.success).toBe(true);
  });

  it("appends multiple records to same file", () => {
    writer.write({ traceId: "a", action: "chat", providerId: "gemini", task: "review", request: { promptSummary: "x", fileCount: 0 }, response: { success: true, charLength: 10 }, latencyMs: 100 });
    writer.write({ traceId: "b", action: "chat", providerId: "codex", task: "review", request: { promptSummary: "y", fileCount: 0 }, response: { success: true, charLength: 20 }, latencyMs: 200 });

    const files = readdirSync(dir);
    const lines = readFileSync(join(dir, files[0]), "utf-8").trim().split("\n");
    expect(lines.length).toBe(2);
  });

  it("reads traces with filtering", () => {
    writer.write({ traceId: "a", action: "chat", providerId: "gemini", task: "review", request: { promptSummary: "x", fileCount: 0 }, response: { success: true, charLength: 10 }, latencyMs: 100 });
    writer.write({ traceId: "b", action: "chat", providerId: "codex", task: "analysis", request: { promptSummary: "y", fileCount: 0 }, response: { success: false, charLength: 0, error: "timeout" }, latencyMs: 5000 });

    const all = writer.query({});
    expect(all.length).toBe(2);

    const geminiOnly = writer.query({ providerId: "gemini" });
    expect(geminiOnly.length).toBe(1);
    expect(geminiOnly[0].providerId).toBe("gemini");

    const failures = writer.query({ successOnly: false, failedOnly: true });
    expect(failures.length).toBe(1);
    expect(failures[0].response.success).toBe(false);
  });

  it("computes quality stats per provider and task", () => {
    writer.write({ traceId: "1", action: "chat", providerId: "gemini", task: "review", request: { promptSummary: "x", fileCount: 0 }, response: { success: true, charLength: 100 }, latencyMs: 1000, quality: { score: 0.8, evaluator: "claude", feedback: "good" } });
    writer.write({ traceId: "2", action: "chat", providerId: "gemini", task: "review", request: { promptSummary: "y", fileCount: 0 }, response: { success: true, charLength: 200 }, latencyMs: 2000, quality: { score: 0.6, evaluator: "claude", feedback: "ok" } });
    writer.write({ traceId: "3", action: "chat", providerId: "codex", task: "review", request: { promptSummary: "z", fileCount: 0 }, response: { success: true, charLength: 150 }, latencyMs: 1500, quality: { score: 0.9, evaluator: "claude", feedback: "great" } });

    const stats = writer.getQualityStats();
    expect(stats.get("gemini:review")?.avgScore).toBeCloseTo(0.7);
    expect(stats.get("gemini:review")?.count).toBe(2);
    expect(stats.get("codex:review")?.avgScore).toBeCloseTo(0.9);
  });

  it("cleans up files older than retention days", () => {
    // Write a file with an old date name
    const oldDate = "2025-01-01.jsonl";
    const { writeFileSync } = await import("fs");
    writeFileSync(join(dir, oldDate), '{"traceId":"old"}\n');

    writer.cleanup(30); // 30-day retention

    const files = readdirSync(dir);
    expect(files).not.toContain(oldDate);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/__tests__/trace.test.ts`
Expected: FAIL — cannot resolve `../trace.js`

**Step 3: Write minimal implementation**

```typescript
// packages/core/src/trace.ts
import { mkdirSync, readdirSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { durableAppendSync } from "./atomic-write.js";

export interface TraceRequest {
  promptSummary: string;
  fileCount: number;
}

export interface TraceResponse {
  success: boolean;
  charLength: number;
  error?: string;
}

export interface TraceQuality {
  score: number;        // 0-1
  evaluator: string;    // who evaluated (e.g. "claude", "codex")
  feedback: string;     // one-line feedback
}

export interface TraceReasoning {
  candidateProviders: string[];
  selectedProvider: string;
  selectionReason: string;
  memoryHit: boolean;
  memoryContext?: string;
}

export interface TraceRecord {
  traceId: string;
  timestamp?: string;          // auto-filled if omitted
  action: string;              // "chat" | "debate_turn" | "cross_validate" | "dispatch"
  providerId: string;
  task: string;
  request: TraceRequest;
  response: TraceResponse;
  latencyMs: number;
  quality?: TraceQuality;
  reasoning?: TraceReasoning;
}

export interface TraceQueryOptions {
  providerId?: string;
  task?: string;
  traceId?: string;
  daysBack?: number;
  successOnly?: boolean;
  failedOnly?: boolean;
  limit?: number;
}

export interface QualityStat {
  providerId: string;
  task: string;
  avgScore: number;
  count: number;
  avgLatencyMs: number;
}

export class TraceWriter {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  write(record: Omit<TraceRecord, "timestamp"> & { timestamp?: string }): void {
    const full: TraceRecord = {
      ...record,
      timestamp: record.timestamp ?? new Date().toISOString(),
    };
    const dateStr = full.timestamp!.slice(0, 10); // YYYY-MM-DD
    const filePath = join(this.dir, `${dateStr}.jsonl`);
    durableAppendSync(filePath, JSON.stringify(full) + "\n");
  }

  query(options: TraceQueryOptions): TraceRecord[] {
    const files = this.getRelevantFiles(options.daysBack);
    let records: TraceRecord[] = [];

    for (const file of files) {
      const content = readFileSync(join(this.dir, file), "utf-8");
      for (const line of content.trim().split("\n")) {
        if (!line) continue;
        try {
          records.push(JSON.parse(line));
        } catch { /* skip malformed */ }
      }
    }

    // Apply filters
    if (options.providerId) {
      records = records.filter((r) => r.providerId === options.providerId);
    }
    if (options.task) {
      records = records.filter((r) => r.task === options.task);
    }
    if (options.traceId) {
      records = records.filter((r) => r.traceId === options.traceId);
    }
    if (options.successOnly) {
      records = records.filter((r) => r.response.success);
    }
    if (options.failedOnly) {
      records = records.filter((r) => !r.response.success);
    }
    if (options.limit) {
      records = records.slice(-options.limit);
    }

    return records;
  }

  getQualityStats(daysBack = 30): Map<string, QualityStat> {
    const records = this.query({ daysBack }).filter((r) => r.quality);
    const groups = new Map<string, { scores: number[]; latencies: number[]; providerId: string; task: string }>();

    for (const r of records) {
      const key = `${r.providerId}:${r.task}`;
      if (!groups.has(key)) {
        groups.set(key, { scores: [], latencies: [], providerId: r.providerId, task: r.task });
      }
      groups.get(key)!.scores.push(r.quality!.score);
      groups.get(key)!.latencies.push(r.latencyMs);
    }

    const stats = new Map<string, QualityStat>();
    for (const [key, group] of groups) {
      const avgScore = group.scores.reduce((a, b) => a + b, 0) / group.scores.length;
      const avgLatencyMs = group.latencies.reduce((a, b) => a + b, 0) / group.latencies.length;
      stats.set(key, { providerId: group.providerId, task: group.task, avgScore, count: group.scores.length, avgLatencyMs });
    }

    return stats;
  }

  cleanup(retentionDays = 30): void {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    for (const file of readdirSync(this.dir)) {
      if (file.endsWith(".jsonl") && file.slice(0, 10) < cutoffStr) {
        try {
          unlinkSync(join(this.dir, file));
        } catch { /* best effort */ }
      }
    }
  }

  private getRelevantFiles(daysBack?: number): string[] {
    let files = readdirSync(this.dir).filter((f) => f.endsWith(".jsonl")).sort();

    if (daysBack) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - daysBack);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      files = files.filter((f) => f.slice(0, 10) >= cutoffStr);
    }

    return files;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run src/__tests__/trace.test.ts`
Expected: PASS

**Step 5: Add export and commit**

Add to `packages/core/src/index.ts`:
```typescript
export * from "./trace.js";
```

```bash
git add packages/core/src/trace.ts packages/core/src/__tests__/trace.test.ts packages/core/src/index.ts
git commit -m "feat: add TraceRecord type and TraceWriter with JSONL persistence"
```

---

### Task 2: Wire TraceWriter into server dispatch

**Files:**
- Modify: `packages/mcp-server/src/server.ts` (add trace middleware)
- Modify: `packages/mcp-server/src/index.ts` (create TraceWriter, pass to deps)
- Test: `packages/mcp-server/src/__tests__/trace-integration.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/mcp-server/src/__tests__/trace-integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { dispatch } from "../server.js";
import { TraceWriter } from "@agestra/core";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Minimal mock deps
function createMockDeps(traceWriter: TraceWriter) {
  return {
    registry: { get: () => ({ id: "mock", chat: async () => ({ text: "ok", model: "m", provider: "mock" }) }) },
    sessionManager: { createSession: () => ({ id: "s1" }), updateSessionStatus: () => {}, completeSession: () => {} },
    documentManager: { createReview: async () => ({ id: "d1" }) },
    memoryFacade: { store: () => "n1", search: async () => [] },
    jobManager: {},
    traceWriter,
  } as any;
}

describe("Trace integration in dispatch", () => {
  let dir: string;
  let writer: TraceWriter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trace-int-"));
    writer = new TraceWriter(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("records trace for provider calls via agent_assign_task", async () => {
    const deps = createMockDeps(writer);
    await dispatch("agent_assign_task", { provider: "mock", task: "test task" }, deps);

    const traces = writer.query({});
    expect(traces.length).toBeGreaterThanOrEqual(1);
    expect(traces[0].providerId).toBe("mock");
    expect(traces[0].action).toBe("chat");
    expect(traces[0].response.success).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/mcp-server && npx vitest run src/__tests__/trace-integration.test.ts`
Expected: FAIL — traceWriter not in ServerDependencies

**Step 3: Modify server.ts — add TraceWriter to deps**

In `packages/mcp-server/src/server.ts`, add to `ServerDependencies`:
```typescript
import type { TraceWriter } from "@agestra/core";

export interface ServerDependencies {
  registry: ProviderRegistry;
  sessionManager: SessionManager;
  documentManager: DocumentManager;
  memoryFacade: MemoryFacade;
  jobManager: JobManager;
  traceWriter?: TraceWriter;  // optional for backward compat
}
```

Pass traceWriter through in `dispatch()` moduleDeps.

**Step 4: Modify agent-session.ts — wrap provider.chat() with trace recording**

In `handleAssignTask` and `handleDebateTurn`, wrap `provider.chat()`:
```typescript
const startTime = performance.now();
const response = await provider.chat({ prompt });
const latencyMs = Math.round(performance.now() - startTime);

if (deps.traceWriter) {
  deps.traceWriter.write({
    traceId: session.id,
    action: "chat",
    providerId: parsed.provider,
    task: parsed.task,
    request: { promptSummary: prompt.slice(0, 100), fileCount: parsed.files?.length ?? 0 },
    response: { success: true, charLength: response.text.length },
    latencyMs,
  });
}
```

Similar wrapping for error paths (success: false).

**Step 5: Modify index.ts — create TraceWriter instance**

```typescript
import { TraceWriter } from "@agestra/core";

// In main():
const traceWriter = new TraceWriter(join(baseDir, ".agestra/traces"));

// Pass to createServer:
const server = createServer({
  registry, sessionManager, documentManager, memoryFacade, jobManager, traceWriter,
});
```

**Step 6: Run test to verify it passes**

Run: `cd packages/mcp-server && npx vitest run src/__tests__/trace-integration.test.ts`
Expected: PASS

**Step 7: Commit**

```bash
git add packages/mcp-server/src/server.ts packages/mcp-server/src/index.ts packages/mcp-server/src/tools/agent-session.ts packages/mcp-server/src/__tests__/trace-integration.test.ts
git commit -m "feat: wire TraceWriter into server dispatch and provider calls"
```

---

### Task 3: Quality scoring in aggregation/debate flows

**Files:**
- Modify: `packages/mcp-server/src/tools/agent-session.ts` (add quality scoring at conclude/dispatch)
- Test: `packages/mcp-server/src/__tests__/trace-quality.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/mcp-server/src/__tests__/trace-quality.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TraceWriter } from "@agestra/core";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("Quality scoring in traces", () => {
  let dir: string;
  let writer: TraceWriter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trace-quality-"));
    writer = new TraceWriter(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("updates trace with quality when updateQuality is called", () => {
    writer.write({
      traceId: "t1",
      action: "debate_turn",
      providerId: "gemini",
      task: "architecture-review",
      request: { promptSummary: "review", fileCount: 0 },
      response: { success: true, charLength: 500 },
      latencyMs: 3000,
    });

    writer.updateQuality("t1", "gemini", {
      score: 0.85,
      evaluator: "codex",
      feedback: "Good analysis but missed edge case",
    });

    const traces = writer.query({ traceId: "t1" });
    expect(traces.length).toBe(1);
    expect(traces[0].quality?.score).toBe(0.85);
    expect(traces[0].quality?.evaluator).toBe("codex");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/mcp-server && npx vitest run src/__tests__/trace-quality.test.ts`
Expected: FAIL — `updateQuality` does not exist

**Step 3: Add updateQuality to TraceWriter**

In `packages/core/src/trace.ts`, add:
```typescript
updateQuality(traceId: string, providerId: string, quality: TraceQuality): void {
  // Read today's file, find matching record, rewrite with quality added
  // For simplicity: append a quality-update record with same traceId
  // Query merges them (last quality wins)
  this.write({
    traceId,
    action: "quality_update",
    providerId,
    task: "",
    request: { promptSummary: "", fileCount: 0 },
    response: { success: true, charLength: 0 },
    latencyMs: 0,
    quality,
  });
}
```

Update `query()` to merge quality_update records into their parent trace:
```typescript
// After collecting records, merge quality updates
const qualityUpdates = records.filter((r) => r.action === "quality_update");
const mainRecords = records.filter((r) => r.action !== "quality_update");

for (const update of qualityUpdates) {
  const target = mainRecords.find(
    (r) => r.traceId === update.traceId && r.providerId === update.providerId
  );
  if (target && update.quality) {
    target.quality = update.quality;
  }
}

records = mainRecords;
```

**Step 4: Wire quality scoring into debate conclude**

In `handleDebateConclude` in `agent-session.ts`:
- After conclude, iterate over turns where speaker !== "claude"
- For each turn, check if another speaker gave feedback (implicit in debate flow)
- Record quality based on debate dynamics (this is a simple heuristic — presence of agreement/disagreement keywords)

Alternatively, simpler approach for V1: Claude (the host AI calling the tools) provides quality scores via a new optional field in `agent_debate_conclude`:
```typescript
const AgentDebateConcludeSchema = z.object({
  debate_id: z.string(),
  summary: z.string().optional(),
  quality_scores: z.array(z.object({
    provider: z.string(),
    score: z.number().min(0).max(1),
    feedback: z.string(),
  })).optional().describe("Claude's quality assessment of each provider's contribution"),
});
```

When provided, write quality updates for each provider:
```typescript
if (parsed.quality_scores && deps.traceWriter) {
  for (const qs of parsed.quality_scores) {
    deps.traceWriter.updateQuality(parsed.debate_id, qs.provider, {
      score: qs.score,
      evaluator: "claude",
      feedback: qs.feedback,
    });
  }
}
```

**Step 5: Run tests**

Run: `npx vitest run src/__tests__/trace-quality.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add packages/core/src/trace.ts packages/mcp-server/src/tools/agent-session.ts packages/mcp-server/src/__tests__/trace-quality.test.ts packages/core/src/__tests__/trace.test.ts
git commit -m "feat: add quality scoring to traces via debate conclude and updateQuality"
```

---

### Task 4: Trace-based routing enhancement

**Files:**
- Modify: `packages/core/src/registry.ts` (add quality-aware routing)
- Test: `packages/core/src/__tests__/registry-quality.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/core/src/__tests__/registry-quality.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ProviderRegistry, TraceWriter } from "../index.js";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Minimal mock provider
function mockProvider(id: string) {
  return {
    id,
    type: id,
    initialize: async () => {},
    healthCheck: async () => ({ status: "ok" as const }),
    getCapabilities: () => ({ maxContext: 1000, supportsSystemPrompt: true, supportsFiles: false, supportsStreaming: false, supportsJsonOutput: false, supportsToolUse: false, strengths: ["code-review"], models: [] }),
    isAvailable: () => true,
    chat: async () => ({ text: "ok", model: "m", provider: id }),
  };
}

describe("ProviderRegistry with quality routing", () => {
  let dir: string;
  let writer: TraceWriter;
  let registry: ProviderRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reg-quality-"));
    writer = new TraceWriter(dir);
    registry = new ProviderRegistry();
    registry.register(mockProvider("gemini"));
    registry.register(mockProvider("codex"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("getBestForTask returns provider with highest quality score", () => {
    // Gemini: 0.6 avg quality for code-review
    writer.write({ traceId: "1", action: "chat", providerId: "gemini", task: "code-review", request: { promptSummary: "", fileCount: 0 }, response: { success: true, charLength: 100 }, latencyMs: 1000, quality: { score: 0.6, evaluator: "claude", feedback: "" } });

    // Codex: 0.9 avg quality for code-review
    writer.write({ traceId: "2", action: "chat", providerId: "codex", task: "code-review", request: { promptSummary: "", fileCount: 0 }, response: { success: true, charLength: 100 }, latencyMs: 1000, quality: { score: 0.9, evaluator: "claude", feedback: "" } });

    const best = registry.getBestForTask("code-review", writer);
    expect(best?.id).toBe("codex");
  });

  it("falls back to first available when no quality data", () => {
    const best = registry.getBestForTask("unknown-task", writer);
    expect(best).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/__tests__/registry-quality.test.ts`
Expected: FAIL — `getBestForTask` not found

**Step 3: Add getBestForTask to ProviderRegistry**

```typescript
// In packages/core/src/registry.ts
import type { TraceWriter } from "./trace.js";

// Add method to ProviderRegistry class:
getBestForTask(task: string, traceWriter?: TraceWriter): AIProvider | undefined {
  const available = this.getAvailable();
  if (available.length === 0) return undefined;
  if (!traceWriter) return available[0];

  const stats = traceWriter.getQualityStats();
  let bestProvider: AIProvider | undefined;
  let bestScore = -1;

  for (const provider of available) {
    const key = `${provider.id}:${task}`;
    const stat = stats.get(key);
    if (stat && stat.avgScore > bestScore) {
      bestScore = stat.avgScore;
      bestProvider = provider;
    }
  }

  return bestProvider ?? available[0];
}
```

**Step 4: Run tests**

Run: `cd packages/core && npx vitest run src/__tests__/registry-quality.test.ts`
Expected: PASS

**Step 5: Run all existing tests to ensure no regression**

Run: `npx vitest run`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add packages/core/src/registry.ts packages/core/src/__tests__/registry-quality.test.ts
git commit -m "feat: add quality-aware provider routing via getBestForTask"
```

---

### Task 5: Semantic Tracing (reasoning field)

**Files:**
- Modify: `packages/mcp-server/src/tools/agent-session.ts` (add reasoning to traces)
- Test: `packages/mcp-server/src/__tests__/trace-reasoning.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/mcp-server/src/__tests__/trace-reasoning.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TraceWriter } from "@agestra/core";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("Semantic tracing — reasoning field", () => {
  let dir: string;
  let writer: TraceWriter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trace-reason-"));
    writer = new TraceWriter(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores reasoning metadata in trace", () => {
    writer.write({
      traceId: "t1",
      action: "chat",
      providerId: "gemini",
      task: "code-review",
      request: { promptSummary: "review", fileCount: 1 },
      response: { success: true, charLength: 500 },
      latencyMs: 3000,
      reasoning: {
        candidateProviders: ["gemini", "codex", "ollama"],
        selectedProvider: "gemini",
        selectionReason: "Highest quality score (0.82) for code-review tasks",
        memoryHit: true,
        memoryContext: "Previously found gemini good at finding bugs",
      },
    });

    const traces = writer.query({ traceId: "t1" });
    expect(traces[0].reasoning).toBeDefined();
    expect(traces[0].reasoning!.selectedProvider).toBe("gemini");
    expect(traces[0].reasoning!.memoryHit).toBe(true);
  });
});
```

**Step 2: Run test — should PASS immediately** since TraceRecord already has `reasoning` field.

**Step 3: Add reasoning recording to agent_assign_task and agent_debate_turn**

In `handleAssignTask`, before calling `provider.chat()`:
```typescript
// Build reasoning context
const reasoning: TraceReasoning | undefined = deps.traceWriter ? {
  candidateProviders: deps.registry.getAvailable().map((p) => p.id),
  selectedProvider: parsed.provider,
  selectionReason: `Explicitly requested provider: ${parsed.provider}`,
  memoryHit: false,
} : undefined;
```

For `handleDebateTurn`:
```typescript
const reasoning: TraceReasoning | undefined = deps.traceWriter ? {
  candidateProviders: state.providerIds,
  selectedProvider: parsed.provider,
  selectionReason: `Debate turn: ${parsed.provider}'s turn to respond`,
  memoryHit: false,
} : undefined;
```

Include in the `writer.write()` call.

**Step 4: Run tests**

Run: `npx vitest run`
Expected: All PASS

**Step 5: Commit**

```bash
git add packages/mcp-server/src/tools/agent-session.ts packages/mcp-server/src/__tests__/trace-reasoning.test.ts
git commit -m "feat: add semantic tracing with reasoning metadata to provider calls"
```

---

### Task 6: MCP trace tools (trace_query, trace_summary, trace_visualize)

**Files:**
- Create: `packages/mcp-server/src/tools/trace.ts`
- Modify: `packages/mcp-server/src/server.ts` (register trace tools)
- Test: `packages/mcp-server/src/__tests__/trace-tools.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/mcp-server/src/__tests__/trace-tools.test.ts
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
```

**Step 2: Run test to verify it fails**

Run: `cd packages/mcp-server && npx vitest run src/__tests__/trace-tools.test.ts`
Expected: FAIL — cannot resolve `../tools/trace.js`

**Step 3: Write implementation**

```typescript
// packages/mcp-server/src/tools/trace.ts
import { z } from "zod";
import type { TraceWriter } from "@agestra/core";

interface TraceToolDeps {
  traceWriter: TraceWriter;
}

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

const TraceQuerySchema = z.object({
  provider_id: z.string().optional(),
  task: z.string().optional(),
  trace_id: z.string().optional(),
  days_back: z.number().optional().default(7),
  limit: z.number().optional().default(50),
});

const TraceSummarySchema = z.object({
  days_back: z.number().optional().default(30),
});

const TraceVisualizeSchema = z.object({
  trace_id: z.string(),
});

export function getTools() {
  return [
    {
      name: "trace_query",
      description: "Query trace records with filtering. Returns recent provider interactions with latency, quality scores, and reasoning.",
      inputSchema: {
        type: "object" as const,
        properties: {
          provider_id: { type: "string", description: "Filter by provider ID" },
          task: { type: "string", description: "Filter by task type" },
          trace_id: { type: "string", description: "Filter by trace ID" },
          days_back: { type: "number", description: "How many days to look back (default: 7)" },
          limit: { type: "number", description: "Max results (default: 50)" },
        },
      },
    },
    {
      name: "trace_summary",
      description: "Get quality and performance stats per provider and task type. Shows average quality scores, latency, and success rates.",
      inputSchema: {
        type: "object" as const,
        properties: {
          days_back: { type: "number", description: "How many days to summarize (default: 30)" },
        },
      },
    },
    {
      name: "trace_visualize",
      description: "Generate a Mermaid diagram showing the flow of a traced operation. Shows provider selection, execution, and quality assessment.",
      inputSchema: {
        type: "object" as const,
        properties: {
          trace_id: { type: "string", description: "Trace ID to visualize" },
        },
        required: ["trace_id"],
      },
    },
  ];
}

export async function handleTool(
  name: string,
  args: unknown,
  deps: TraceToolDeps,
): Promise<McpToolResult> {
  switch (name) {
    case "trace_query":
      return handleTraceQuery(args, deps);
    case "trace_summary":
      return handleTraceSummary(args, deps);
    case "trace_visualize":
      return handleTraceVisualize(args, deps);
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}

function handleTraceQuery(args: unknown, deps: TraceToolDeps): McpToolResult {
  const parsed = TraceQuerySchema.parse(args);
  const records = deps.traceWriter.query({
    providerId: parsed.provider_id,
    task: parsed.task,
    traceId: parsed.trace_id,
    daysBack: parsed.days_back,
    limit: parsed.limit,
  });

  if (records.length === 0) {
    return { content: [{ type: "text", text: "No trace records found." }] };
  }

  let text = `**Trace Records** (${records.length} results)\n\n`;
  for (const r of records) {
    text += `| ${r.timestamp?.slice(0, 19)} | ${r.providerId} | ${r.task} | ${r.latencyMs}ms | ${r.response.success ? "OK" : "FAIL"} |`;
    if (r.quality) text += ` quality: ${r.quality.score}`;
    text += "\n";
  }

  return { content: [{ type: "text", text }] };
}

function handleTraceSummary(args: unknown, deps: TraceToolDeps): McpToolResult {
  const parsed = TraceSummarySchema.parse(args);
  const stats = deps.traceWriter.getQualityStats(parsed.days_back);

  if (stats.size === 0) {
    return { content: [{ type: "text", text: "No quality data available yet." }] };
  }

  let text = `**Provider Quality Summary** (last ${parsed.days_back} days)\n\n`;
  text += `| Provider:Task | Avg Quality | Count | Avg Latency |\n`;
  text += `|---|---|---|---|\n`;

  for (const [key, stat] of stats) {
    text += `| ${key} | ${stat.avgScore.toFixed(2)} | ${stat.count} | ${Math.round(stat.avgLatencyMs)}ms |\n`;
  }

  return { content: [{ type: "text", text }] };
}

function handleTraceVisualize(args: unknown, deps: TraceToolDeps): McpToolResult {
  const parsed = TraceVisualizeSchema.parse(args);
  const records = deps.traceWriter.query({ traceId: parsed.trace_id });

  if (records.length === 0) {
    return { content: [{ type: "text", text: `No records found for trace: ${parsed.trace_id}` }], isError: true };
  }

  // Build Mermaid diagram
  let mermaid = "```mermaid\ngraph LR\n";
  mermaid += `    A[User Request] --> B{Provider Selection}\n`;

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const nodeId = String.fromCharCode(67 + i); // C, D, E, ...
    const nextId = String.fromCharCode(67 + i + 1);

    // Selection edge
    const label = r.reasoning?.selectionReason
      ? r.reasoning.selectionReason.slice(0, 40)
      : `${r.latencyMs}ms`;
    mermaid += `    B -->|${label}| ${nodeId}[${r.providerId}]\n`;

    // Result edge
    const resultLabel = r.response.success
      ? `${r.response.charLength} chars, ${r.latencyMs}ms`
      : `FAIL: ${r.response.error?.slice(0, 30) ?? "error"}`;
    mermaid += `    ${nodeId} --> ${nodeId}R[${resultLabel}]\n`;

    // Quality edge
    if (r.quality) {
      mermaid += `    ${nodeId}R --> ${nodeId}Q[Quality: ${r.quality.score}]\n`;
    }
  }

  mermaid += "```";

  let text = `**Trace Visualization: ${parsed.trace_id}**\n\n${mermaid}`;
  return { content: [{ type: "text", text }] };
}
```

**Step 4: Register in server.ts**

Add to `TOOL_MODULES` in `server.ts`:
```typescript
import * as trace from "./tools/trace.js";
// Add to TOOL_MODULES array:
const TOOL_MODULES: ToolModule[] = [
  aiChat, agentSession, workspace, providerManage, ollamaManage, memory, jobs, trace,
];
```

**Step 5: Run tests**

Run: `npx vitest run`
Expected: All PASS

**Step 6: Commit**

```bash
git add packages/mcp-server/src/tools/trace.ts packages/mcp-server/src/server.ts packages/mcp-server/src/__tests__/trace-tools.test.ts
git commit -m "feat: add trace_query, trace_summary, trace_visualize MCP tools"
```

---

### Task 7: Memory tiering — L1 session cache

**Files:**
- Create: `packages/memory/src/session-cache.ts`
- Modify: `packages/memory/src/facade.ts` (add L1 cache before hybrid search)
- Test: `packages/memory/src/__tests__/session-cache.test.ts`

**Step 1: Write the failing test**

```typescript
// packages/memory/src/__tests__/session-cache.test.ts
import { describe, it, expect } from "vitest";
import { SessionCache } from "../session-cache.js";

describe("SessionCache (L1 memory tier)", () => {
  it("stores and retrieves by keyword match", () => {
    const cache = new SessionCache();
    cache.add("session1", "Gemini is good at code review");
    cache.add("session1", "Use Codex for architecture tasks");

    const results = cache.search("code review");
    expect(results.length).toBe(1);
    expect(results[0].content).toContain("code review");
  });

  it("returns empty for no match", () => {
    const cache = new SessionCache();
    cache.add("s1", "hello world");
    expect(cache.search("database")).toHaveLength(0);
  });

  it("clears a session", () => {
    const cache = new SessionCache();
    cache.add("s1", "data A");
    cache.add("s2", "data B");

    cache.clearSession("s1");
    expect(cache.search("data A")).toHaveLength(0);
    expect(cache.search("data B")).toHaveLength(1);
  });

  it("relevance threshold filters weak matches", () => {
    const cache = new SessionCache();
    cache.add("s1", "TypeScript React Next.js frontend development");
    cache.add("s1", "Python Django backend development");

    const results = cache.search("TypeScript React");
    expect(results.length).toBe(1);
    expect(results[0].content).toContain("TypeScript");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/memory && npx vitest run src/__tests__/session-cache.test.ts`
Expected: FAIL — cannot resolve `../session-cache.js`

**Step 3: Write implementation**

```typescript
// packages/memory/src/session-cache.ts

export interface SessionCacheEntry {
  sessionId: string;
  content: string;
  keywords: Set<string>;
  addedAt: number;
}

export interface SessionCacheResult {
  content: string;
  score: number;
  sessionId: string;
}

export class SessionCache {
  private entries: SessionCacheEntry[] = [];

  add(sessionId: string, content: string): void {
    const keywords = this.extractKeywords(content);
    this.entries.push({ sessionId, content, keywords, addedAt: Date.now() });
  }

  search(query: string, minScore = 0.3): SessionCacheResult[] {
    const queryKeywords = this.extractKeywords(query);
    if (queryKeywords.size === 0) return [];

    const results: SessionCacheResult[] = [];

    for (const entry of this.entries) {
      let matches = 0;
      for (const kw of queryKeywords) {
        if (entry.keywords.has(kw)) matches++;
      }
      const score = matches / queryKeywords.size;

      if (score >= minScore) {
        results.push({ content: entry.content, score, sessionId: entry.sessionId });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  clearSession(sessionId: string): void {
    this.entries = this.entries.filter((e) => e.sessionId !== sessionId);
  }

  clear(): void {
    this.entries = [];
  }

  get size(): number {
    return this.entries.length;
  }

  private extractKeywords(text: string): Set<string> {
    return new Set(
      text.toLowerCase()
        .replace(/[^\w\s가-힣]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 1),
    );
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/memory && npx vitest run src/__tests__/session-cache.test.ts`
Expected: PASS

**Step 5: Wire into MemoryFacade**

In `packages/memory/src/facade.ts`:

Add import and property:
```typescript
import { SessionCache } from './session-cache.js';

// In class MemoryFacade:
private sessionCache = new SessionCache();
```

Modify `search()` to check L1 first:
```typescript
async search(
  query: string,
  options?: { topic?: MemoryTopic; nodeType?: NodeType; limit?: number },
): Promise<RetrievalResult[]> {
  this.ensureInitialized();

  // L1: Session cache (instant)
  const cacheResults = this.sessionCache.search(query);
  if (cacheResults.length > 0 && cacheResults[0].score >= 0.7) {
    // Convert to RetrievalResult format
    return cacheResults.slice(0, options?.limit ?? 10).map((r) => ({
      node: {
        id: `session-${Date.now()}`,
        content: r.content,
        nodeType: 'fact' as const,
        topic: 'context' as const,
        importance: 0.5,
        source: 'session' as const,
        pinned: false,
        conversationId: r.sessionId,
        messageId: null,
        lastAccessed: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        embeddingVersion: null,
        extractorVersion: null,
        sourceHash: null,
        dedupeKey: null,
        deletedAt: null,
        providerId: null,
        lastMentionedAt: null,
        mentionCount: 0,
        confidence: r.score,
      },
      score: r.score,
      source: 'fts' as const, // Closest match in existing type
    }));
  }

  // L2+L3: Existing hybrid search (vector + graph)
  return this.retriever!.search(query, options);
}
```

Add public method to populate session cache:
```typescript
addToSessionCache(sessionId: string, content: string): void {
  this.sessionCache.add(sessionId, content);
}

clearSessionCache(sessionId?: string): void {
  if (sessionId) {
    this.sessionCache.clearSession(sessionId);
  } else {
    this.sessionCache.clear();
  }
}
```

**Step 6: Run all memory tests**

Run: `cd packages/memory && npx vitest run`
Expected: All PASS

**Step 7: Commit**

```bash
git add packages/memory/src/session-cache.ts packages/memory/src/__tests__/session-cache.test.ts packages/memory/src/facade.ts
git commit -m "feat: add L1 session cache for memory tiering"
```

---

### Task 8: Bundle update + full test suite

**Files:**
- Modify: `scripts/bundle.mjs` (ensure new files are included)
- Run all tests

**Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

**Step 2: Rebuild bundle**

Run: `npm run bundle`
Expected: `dist/bundle.js` built without errors

**Step 3: Verify trace tools appear in tool list**

Run: `node dist/bundle.js 2>&1 | head -5` (or check tool count in test)

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: verify bundle and full test suite with new trace/memory features"
```

---

### Task 9: Trace cleanup on server start

**Files:**
- Modify: `packages/mcp-server/src/index.ts` (add cleanup on startup)

**Step 1: Add cleanup call in main()**

After creating TraceWriter:
```typescript
const traceWriter = new TraceWriter(join(baseDir, ".agestra/traces"));
traceWriter.cleanup(30); // Remove files older than 30 days
```

**Step 2: Run tests**

Run: `npx vitest run`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/mcp-server/src/index.ts
git commit -m "feat: auto-cleanup trace files older than 30 days on startup"
```
