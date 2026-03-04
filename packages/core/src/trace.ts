import { mkdirSync, readdirSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { durableAppendSync } from "./atomic-write.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface TraceRecord {
  traceId: string;
  timestamp?: string;
  action: string;  // "chat" | "debate_turn" | "cross_validate" | "dispatch"
  providerId: string;
  task: string;
  request: { promptSummary: string; fileCount: number };
  response: { success: boolean; charLength: number; error?: string };
  latencyMs: number;
  quality?: { score: number; evaluator: string; feedback: string };
  reasoning?: {
    candidateProviders: string[];
    selectedProvider: string;
    selectionReason: string;
    memoryHit: boolean;
    memoryContext?: string;
  };
}

export interface QualityUpdate {
  type: "quality_update";
  traceId: string;
  providerId: string;
  timestamp: string;
  quality: { score: number; evaluator: string; feedback: string };
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

export interface QualityStats {
  avgScore: number;
  count: number;
  avgLatencyMs: number;
}

// ── Helpers ────────────────────────────────────────────────────────────

function formatDateISO(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function isTraceRecord(obj: unknown): obj is TraceRecord {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "traceId" in obj &&
    "action" in obj &&
    !("type" in obj && (obj as Record<string, unknown>).type === "quality_update")
  );
}

function isQualityUpdate(obj: unknown): obj is QualityUpdate {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "type" in obj &&
    (obj as Record<string, unknown>).type === "quality_update"
  );
}

// ── TraceWriter ────────────────────────────────────────────────────────

export class TraceWriter {
  private readonly tracesDir: string;

  constructor(dir: string) {
    this.tracesDir = join(dir, ".agestra", "traces");
    mkdirSync(this.tracesDir, { recursive: true });
  }

  /**
   * Append a trace record to the dated JSONL file.
   * Auto-fills timestamp if not provided.
   */
  write(record: TraceRecord): void {
    const filled: TraceRecord = {
      ...record,
      timestamp: record.timestamp ?? new Date().toISOString(),
    };
    const dateStr = formatDateISO(new Date(filled.timestamp!));
    const filePath = join(this.tracesDir, `${dateStr}.jsonl`);
    durableAppendSync(filePath, JSON.stringify(filled) + "\n");
  }

  /**
   * Query trace records with filtering.
   * Quality-update records are merged into their parent traces.
   */
  query(options: TraceQueryOptions = {}): TraceRecord[] {
    const files = this.listFiles(options.daysBack);
    const traces: TraceRecord[] = [];
    const qualityUpdates: QualityUpdate[] = [];

    for (const file of files) {
      const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (isQualityUpdate(obj)) {
            qualityUpdates.push(obj);
          } else if (isTraceRecord(obj)) {
            traces.push(obj);
          }
        } catch {
          // skip malformed lines
        }
      }
    }

    // Merge quality updates into parent traces
    for (const qu of qualityUpdates) {
      const parent = traces.find(
        (t) => t.traceId === qu.traceId && t.providerId === qu.providerId,
      );
      if (parent) {
        parent.quality = qu.quality;
      }
    }

    // Apply filters
    let result = traces;

    if (options.providerId) {
      result = result.filter((t) => t.providerId === options.providerId);
    }
    if (options.task) {
      result = result.filter((t) => t.task === options.task);
    }
    if (options.traceId) {
      result = result.filter((t) => t.traceId === options.traceId);
    }
    if (options.successOnly) {
      result = result.filter((t) => t.response.success);
    }
    if (options.failedOnly) {
      result = result.filter((t) => !t.response.success);
    }
    if (options.limit !== undefined) {
      result = result.slice(0, options.limit);
    }

    return result;
  }

  /**
   * Append a quality_update record. On query(), it is merged into the
   * matching parent trace.
   */
  updateQuality(
    traceId: string,
    providerId: string,
    quality: { score: number; evaluator: string; feedback: string },
  ): void {
    const now = new Date();
    const update: QualityUpdate = {
      type: "quality_update",
      traceId,
      providerId,
      timestamp: now.toISOString(),
      quality,
    };
    const dateStr = formatDateISO(now);
    const filePath = join(this.tracesDir, `${dateStr}.jsonl`);
    durableAppendSync(filePath, JSON.stringify(update) + "\n");
  }

  /**
   * Compute per-provider-task quality stats.
   * Returns Map<"providerId:task", QualityStats>.
   */
  getQualityStats(daysBack: number): Map<string, QualityStats> {
    const traces = this.query({ daysBack });
    const buckets = new Map<
      string,
      { totalScore: number; count: number; totalLatency: number }
    >();

    for (const t of traces) {
      if (!t.quality) continue;
      const key = `${t.providerId}:${t.task}`;
      const bucket = buckets.get(key) ?? {
        totalScore: 0,
        count: 0,
        totalLatency: 0,
      };
      bucket.totalScore += t.quality.score;
      bucket.count += 1;
      bucket.totalLatency += t.latencyMs;
      buckets.set(key, bucket);
    }

    const stats = new Map<string, QualityStats>();
    for (const [key, b] of buckets) {
      stats.set(key, {
        avgScore: b.totalScore / b.count,
        count: b.count,
        avgLatencyMs: b.totalLatency / b.count,
      });
    }
    return stats;
  }

  /**
   * Delete JSONL files older than retentionDays.
   */
  cleanup(retentionDays: number): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    let deleted = 0;

    let files: string[];
    try {
      files = readdirSync(this.tracesDir);
    } catch {
      return 0;
    }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const datePart = file.replace(".jsonl", "");
      const fileDate = new Date(datePart + "T00:00:00.000Z");
      if (isNaN(fileDate.getTime())) continue;

      if (fileDate < cutoff) {
        unlinkSync(join(this.tracesDir, file));
        deleted++;
      }
    }
    return deleted;
  }

  // ── Private ──────────────────────────────────────────────────────────

  private listFiles(daysBack?: number): string[] {
    let files: string[];
    try {
      files = readdirSync(this.tracesDir)
        .filter((f) => f.endsWith(".jsonl"))
        .sort();
    } catch {
      return [];
    }

    if (daysBack !== undefined) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - daysBack);
      files = files.filter((f) => {
        const datePart = f.replace(".jsonl", "");
        const fileDate = new Date(datePart + "T00:00:00.000Z");
        return !isNaN(fileDate.getTime()) && fileDate >= cutoff;
      });
    }

    return files.map((f) => join(this.tracesDir, f));
  }
}
