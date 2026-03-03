import { z } from "zod";
import type { ProviderRegistry } from "@agestra/core";

// ── Zod schemas ──────────────────────────────────────────────

const ProviderHealthSchema = z.object({
  provider: z.string().optional().describe("Provider ID to check (omit to check all)"),
});

// ── Types ────────────────────────────────────────────────────

export interface ProviderManageToolDeps {
  registry: ProviderRegistry;
}

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// ── Tool definitions ─────────────────────────────────────────

export function getTools() {
  return [
    {
      name: "provider_list",
      description:
        "List all registered AI providers with their availability status and capabilities.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [] as string[],
      },
    },
    {
      name: "provider_health",
      description:
        "Run health checks on AI providers. Optionally specify a provider ID, or omit to check all.",
      inputSchema: {
        type: "object" as const,
        properties: {
          provider: {
            type: "string",
            description: "Provider ID to check (omit to check all)",
          },
        },
        required: [] as string[],
      },
    },
  ];
}

// ── Handlers ─────────────────────────────────────────────────

async function handleProviderList(
  deps: ProviderManageToolDeps,
): Promise<McpToolResult> {
  const providers = deps.registry.getAll();

  if (providers.length === 0) {
    return {
      content: [{ type: "text", text: "No providers registered." }],
    };
  }

  let text = `# Registered Providers (${providers.length})\n\n`;

  for (const provider of providers) {
    const available = provider.isAvailable();
    const caps = provider.getCapabilities();
    const status = available ? "Available" : "Unavailable";

    text += `## ${provider.id} (${provider.type})\n`;
    text += `- **Status:** ${status}\n`;
    text += `- **Max Context:** ${caps.maxContext}\n`;
    text += `- **System Prompt:** ${caps.supportsSystemPrompt ? "Yes" : "No"}\n`;
    text += `- **Files:** ${caps.supportsFiles ? "Yes" : "No"}\n`;
    text += `- **Streaming:** ${caps.supportsStreaming ? "Yes" : "No"}\n`;
    text += `- **JSON Output:** ${caps.supportsJsonOutput ? "Yes" : "No"}\n`;
    text += `- **Tool Use:** ${caps.supportsToolUse ? "Yes" : "No"}\n`;
    if (caps.strengths.length > 0) {
      text += `- **Strengths:** ${caps.strengths.join(", ")}\n`;
    }
    if (caps.models.length > 0) {
      text += `- **Models:** ${caps.models.map((m) => m.name).join(", ")}\n`;
    }
    text += "\n";
  }

  return { content: [{ type: "text", text }] };
}

async function handleProviderHealth(
  args: unknown,
  deps: ProviderManageToolDeps,
): Promise<McpToolResult> {
  const parsed = ProviderHealthSchema.parse(args);

  const providers = parsed.provider
    ? [deps.registry.get(parsed.provider)]
    : deps.registry.getAll();

  if (providers.length === 0) {
    return {
      content: [{ type: "text", text: "No providers to check." }],
    };
  }

  const results = await Promise.all(
    providers.map(async (provider) => {
      try {
        const health = await provider.healthCheck();
        return {
          id: provider.id,
          type: provider.type,
          status: health.status,
          message: health.message,
          details: health.details,
          error: null,
        };
      } catch (err) {
        return {
          id: provider.id,
          type: provider.type,
          status: "error" as const,
          message: err instanceof Error ? err.message : String(err),
          details: undefined,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  let text = `# Health Check Results\n\n`;

  for (const result of results) {
    const icon =
      result.status === "ok"
        ? "OK"
        : result.status === "degraded"
          ? "DEGRADED"
          : "ERROR";

    text += `## ${result.id} (${result.type})\n`;
    text += `- **Status:** ${icon}\n`;
    if (result.message) {
      text += `- **Message:** ${result.message}\n`;
    }
    if (result.error) {
      text += `- **Error:** ${result.error}\n`;
    }
    text += "\n";
  }

  return { content: [{ type: "text", text }] };
}

// ── Dispatcher ───────────────────────────────────────────────

export async function handleTool(
  name: string,
  args: unknown,
  deps: ProviderManageToolDeps,
): Promise<McpToolResult> {
  switch (name) {
    case "provider_list":
      return handleProviderList(deps);
    case "provider_health":
      return handleProviderHealth(args, deps);
    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
}
