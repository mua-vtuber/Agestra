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

  const text = `**Trace Visualization: ${parsed.trace_id}**\n\n${mermaid}`;
  return { content: [{ type: "text", text }] };
}
