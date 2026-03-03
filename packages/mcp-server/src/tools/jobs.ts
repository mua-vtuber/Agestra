import { z } from "zod";
import type { JobManager } from "@agestra/core";
import type { MemoryFacade } from "@agestra/memory";

// ── Zod schemas ──────────────────────────────────────────────

const CliJobSubmitSchema = z.object({
  provider: z.string().describe("Provider ID (e.g. 'gemini', 'codex')"),
  prompt: z.string().describe("Prompt to send to the provider CLI"),
  timeout: z.number().int().positive().optional().describe("Timeout in ms (default: 300000)"),
  cli_command: z.string().optional().describe("Custom CLI command (overrides provider default)"),
  cli_args: z.array(z.string()).optional().describe("Custom CLI args template (use {prompt} for prompt placeholder)"),
});

const CliJobStatusSchema = z.object({
  job_id: z.string().describe("Job ID returned by cli_job_submit"),
});

// ── Types ────────────────────────────────────────────────────

export interface JobToolDeps {
  jobManager: JobManager;
  memoryFacade: MemoryFacade;
}

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// ── Tool definitions ─────────────────────────────────────────

export function getTools() {
  return [
    {
      name: "cli_job_submit",
      description:
        "Submit a long-running CLI job to a provider. Returns a job ID immediately. Use cli_job_status to check progress.",
      inputSchema: {
        type: "object" as const,
        properties: {
          provider: { type: "string", description: "Provider ID (e.g. 'gemini', 'codex')" },
          prompt: { type: "string", description: "Prompt to send to the provider CLI" },
          timeout: { type: "number", description: "Timeout in ms (default: 300000)" },
          cli_command: { type: "string", description: "Custom CLI command (overrides provider default)" },
          cli_args: { type: "array", items: { type: "string" }, description: "Custom CLI args template (use {prompt} for prompt placeholder)" },
        },
        required: ["provider", "prompt"],
      },
    },
    {
      name: "cli_job_status",
      description:
        "Check the status of a CLI job. Returns state, output (on completion), and stderr.",
      inputSchema: {
        type: "object" as const,
        properties: {
          job_id: { type: "string", description: "Job ID returned by cli_job_submit" },
        },
        required: ["job_id"],
      },
    },
  ];
}

// ── Handlers ─────────────────────────────────────────────────

async function handleCliJobSubmit(
  args: unknown,
  deps: JobToolDeps,
): Promise<McpToolResult> {
  const parsed = CliJobSubmitSchema.parse(args);

  const jobId = deps.jobManager.submit({
    provider: parsed.provider,
    prompt: parsed.prompt,
    timeout: parsed.timeout,
    cliCommand: parsed.cli_command,
    cliArgs: parsed.cli_args,
  });

  return {
    content: [
      {
        type: "text",
        text: `**Job submitted**\n**Job ID:** ${jobId}\n**Provider:** ${parsed.provider}\n\nUse \`cli_job_status\` with this job_id to check progress.`,
      },
    ],
  };
}

async function handleCliJobStatus(
  args: unknown,
  deps: JobToolDeps,
): Promise<McpToolResult> {
  const parsed = CliJobStatusSchema.parse(args);

  const result = deps.jobManager.getResult(parsed.job_id);
  if (!result) {
    return {
      content: [{ type: "text", text: `Job not found: ${parsed.job_id}` }],
      isError: true,
    };
  }

  let text = `**Job ID:** ${result.id}\n**State:** ${result.state}`;

  if (result.exitCode !== undefined) {
    text += `\n**Exit Code:** ${result.exitCode}`;
  }

  if (result.output) {
    text += `\n\n---\n\n**Output:**\n${result.output}`;
  }

  if (result.error) {
    text += `\n\n**Stderr:**\n${result.error}`;
  }

  // Record failures as dead_ends in GraphRAG
  if (result.state === "error" || result.state === "timed_out" || result.state === "missing_cli") {
    deps.memoryFacade.store({
      content: `CLI job failed (${result.state}): ${parsed.job_id} — ${result.error ?? "unknown error"}`,
      nodeType: "dead_end",
      topic: "technical",
      importance: 0.7,
      source: "auto",
    });
  }

  return {
    content: [{ type: "text", text }],
    isError: result.state === "error" || result.state === "missing_cli",
  };
}

// ── Dispatcher ───────────────────────────────────────────────

export async function handleTool(
  name: string,
  args: unknown,
  deps: JobToolDeps,
): Promise<McpToolResult> {
  switch (name) {
    case "cli_job_submit":
      return handleCliJobSubmit(args, deps);
    case "cli_job_status":
      return handleCliJobStatus(args, deps);
    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
}
