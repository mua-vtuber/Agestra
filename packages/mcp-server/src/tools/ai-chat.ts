import { z } from "zod";
import { readFileSync } from "fs";
import { resolve, relative } from "path";
import type { ProviderRegistry, AIProvider, TraceWriter } from "@agestra/core";
import { atomicWriteSync } from "@agestra/core";

// ── Zod schemas ──────────────────────────────────────────────

const AiChatSchema = z.object({
  provider: z.string().describe("Provider ID (e.g. 'ollama', 'gemini', 'codex')"),
  prompt: z.string().describe("Chat prompt to send"),
  model: z.string().optional().describe("Model override"),
  system: z.string().optional().describe("System prompt"),
  files: z.array(z.string()).optional().describe("File paths to include as context"),
});

const AiAnalyzeFilesSchema = z.object({
  provider: z.string().describe("Provider ID"),
  file_paths: z.array(z.string()).min(1).describe("File paths to analyze"),
  question: z.string().describe("Question to ask about the files"),
  save_to_file: z.string().optional().describe("Path to save the analysis result"),
});

const AiCompareSchema = z.object({
  providers: z.array(z.string()).min(1).describe("List of provider IDs to compare"),
  prompt: z.string().describe("Prompt to send to all providers"),
  aggregate_provider: z.string().optional().describe("Provider ID to synthesize all responses into a unified document. If omitted, returns raw comparisons only."),
  aggregate_prompt: z.string().optional().describe("Custom synthesis prompt. Default: synthesize and identify agreements/disagreements."),
});

// ── Types ────────────────────────────────────────────────────

export interface ToolDeps {
  registry: ProviderRegistry;
  traceWriter?: TraceWriter;
}

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// ── Path validation ─────────────────────────────────────────

function assertPathSafe(filePath: string): string {
  const cwd = process.cwd();
  const resolved = resolve(cwd, filePath);
  const rel = relative(cwd, resolved);
  if (rel.startsWith("..")) {
    throw new Error(`Path traversal blocked: ${filePath} escapes working directory`);
  }
  return resolved;
}

// ── Tool definitions ─────────────────────────────────────────

export function getTools() {
  return [
    {
      name: "ai_chat",
      description:
        "Chat with a specific AI provider. Sends a prompt and returns the response.",
      inputSchema: {
        type: "object" as const,
        properties: {
          provider: { type: "string", description: "Provider ID (e.g. 'ollama', 'gemini', 'codex')" },
          prompt: { type: "string", description: "Chat prompt to send" },
          model: { type: "string", description: "Model override" },
          system: { type: "string", description: "System prompt" },
          files: {
            type: "array",
            items: { type: "string" },
            description: "File paths to include as context",
          },
        },
        required: ["provider", "prompt"],
      },
    },
    {
      name: "ai_analyze_files",
      description:
        "Analyze files with an AI provider. Reads files from disk, sends contents with a question, and optionally saves the result.",
      inputSchema: {
        type: "object" as const,
        properties: {
          provider: { type: "string", description: "Provider ID" },
          file_paths: {
            type: "array",
            items: { type: "string" },
            description: "File paths to analyze",
          },
          question: { type: "string", description: "Question to ask about the files" },
          save_to_file: {
            type: "string",
            description: "Path to save the analysis result",
          },
        },
        required: ["provider", "file_paths", "question"],
      },
    },
    {
      name: "ai_compare",
      description:
        "Send the same prompt to multiple providers and return a comparison. Optionally aggregate results into a unified synthesis using a designated provider.",
      inputSchema: {
        type: "object" as const,
        properties: {
          providers: {
            type: "array",
            items: { type: "string" },
            description: "List of provider IDs to compare",
          },
          prompt: { type: "string", description: "Prompt to send to all providers" },
          aggregate_provider: {
            type: "string",
            description: "Provider ID to synthesize all responses into a unified document",
          },
          aggregate_prompt: {
            type: "string",
            description: "Custom synthesis prompt (default: synthesize agreements/disagreements)",
          },
        },
        required: ["providers", "prompt"],
      },
    },
  ];
}

// ── Handlers ─────────────────────────────────────────────────

async function handleAiChat(
  args: unknown,
  deps: ToolDeps,
): Promise<McpToolResult> {
  const parsed = AiChatSchema.parse(args);
  const provider = parsed.provider === "auto"
    ? deps.registry.getBestForTask("chat", deps.traceWriter) ?? deps.registry.getAvailable()[0]
    : deps.registry.get(parsed.provider);
  if (!provider) throw new Error("No providers available for auto-routing");

  const response = await provider.chat({
    prompt: parsed.prompt,
    model: parsed.model,
    system: parsed.system,
    files: parsed.files?.map((path) => ({ path })),
  });

  return {
    content: [
      {
        type: "text",
        text: `**Provider:** ${response.provider}\n**Model:** ${response.model}\n\n${response.text}`,
      },
    ],
  };
}

async function handleAiAnalyzeFiles(
  args: unknown,
  deps: ToolDeps,
): Promise<McpToolResult> {
  const parsed = AiAnalyzeFilesSchema.parse(args);
  const provider = parsed.provider === "auto"
    ? deps.registry.getBestForTask("analysis", deps.traceWriter) ?? deps.registry.getAvailable()[0]
    : deps.registry.get(parsed.provider);
  if (!provider) throw new Error("No providers available for auto-routing");

  // Read file contents (with path validation)
  const fileContents = parsed.file_paths.map((filePath) => {
    const safePath = assertPathSafe(filePath);
    const content = readFileSync(safePath, "utf-8");
    return `--- ${filePath} ---\n${content}`;
  });

  const combinedPrompt = `${fileContents.join("\n\n")}\n\n---\n\nQuestion: ${parsed.question}`;

  const response = await provider.chat({ prompt: combinedPrompt });

  // Optionally save to file (with path validation)
  if (parsed.save_to_file) {
    const safeSavePath = assertPathSafe(parsed.save_to_file);
    atomicWriteSync(safeSavePath, response.text);
  }

  const savedNote = parsed.save_to_file
    ? `\n\n_Result saved to: ${parsed.save_to_file}_`
    : "";

  return {
    content: [
      {
        type: "text",
        text: `**Provider:** ${response.provider}\n**Files analyzed:** ${parsed.file_paths.join(", ")}\n\n${response.text}${savedNote}`,
      },
    ],
  };
}

async function handleAiCompare(
  args: unknown,
  deps: ToolDeps,
): Promise<McpToolResult> {
  const parsed = AiCompareSchema.parse(args);

  // Resolve all providers first (fail fast if any are missing)
  const providers: AIProvider[] = parsed.providers.map((id) =>
    deps.registry.get(id),
  );

  // Call all providers in parallel
  const results = await Promise.all(
    providers.map(async (provider) => {
      try {
        const response = await provider.chat({ prompt: parsed.prompt });
        return { provider: provider.id, text: response.text, error: null };
      } catch (err) {
        return {
          provider: provider.id,
          text: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  // Build comparison text
  let comparison = `# Comparison\n\n**Prompt:** ${parsed.prompt}\n\n`;
  for (const result of results) {
    comparison += `## ${result.provider}\n\n`;
    if (result.error) {
      comparison += `**Error:** ${result.error}\n\n`;
    } else {
      comparison += `${result.text}\n\n`;
    }
  }

  // Aggregate results if requested
  let synthesis: string | undefined;
  if (parsed.aggregate_provider) {
    const aggregator = deps.registry.get(parsed.aggregate_provider);
    const successfulResults = results.filter((r) => r.text !== null);

    if (successfulResults.length > 0) {
      const defaultPrompt = [
        "You are synthesizing multiple AI responses into a unified analysis.",
        "For each topic covered, identify:",
        "1. **Agreements** — points where all providers align",
        "2. **Disagreements** — conflicting opinions with each side's reasoning",
        "3. **Unique insights** — valuable points raised by only one provider",
        "4. **Recommended conclusion** — your synthesis of the best answer",
        "",
        "Produce a structured document, not a simple concatenation.",
      ].join("\n");

      const aggregatePrompt = `${parsed.aggregate_prompt ?? defaultPrompt}\n\n---\n\n${comparison}`;

      try {
        const response = await aggregator.chat({ prompt: aggregatePrompt });
        synthesis = response.text;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        synthesis = `[Aggregation failed: ${message}]`;
      }
    }
  }

  let output = comparison;
  if (synthesis) {
    output += `---\n\n# Synthesis\n\n${synthesis}`;
  }

  return {
    content: [{ type: "text", text: output }],
  };
}

// ── Dispatcher ───────────────────────────────────────────────

export async function handleTool(
  name: string,
  args: unknown,
  deps: ToolDeps,
): Promise<McpToolResult> {
  switch (name) {
    case "ai_chat":
      return handleAiChat(args, deps);
    case "ai_analyze_files":
      return handleAiAnalyzeFiles(args, deps);
    case "ai_compare":
      return handleAiCompare(args, deps);
    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
}
