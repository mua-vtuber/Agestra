import { z } from "zod";
import type { ProviderRegistry } from "@agestra/core";
import type { OllamaProvider } from "@agestra/provider-ollama";

// ── Zod schemas ──────────────────────────────────────────────

const OllamaPullSchema = z.object({
  model: z.string().describe("Model name to download (e.g. 'llama3', 'codellama')"),
});

// ── Types ────────────────────────────────────────────────────

export interface OllamaToolDeps {
  registry: ProviderRegistry;
  ollamaProviderId?: string; // default: "ollama"
}

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// ── Tool definitions ─────────────────────────────────────────

export function getTools() {
  return [
    {
      name: "ollama_models",
      description:
        "List installed Ollama models with their sizes and capabilities.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [] as string[],
      },
    },
    {
      name: "ollama_pull",
      description:
        "Download (pull) a model from the Ollama registry.",
      inputSchema: {
        type: "object" as const,
        properties: {
          model: { type: "string", description: "Model name to download (e.g. 'llama3', 'codellama')" },
        },
        required: ["model"],
      },
    },
  ];
}

// ── Helpers ──────────────────────────────────────────────────

function getOllamaProvider(deps: OllamaToolDeps): OllamaProvider {
  const id = deps.ollamaProviderId || "ollama";
  const provider = deps.registry.get(id);

  // Cast to OllamaProvider — we trust the registry to hold the correct type
  if (provider.type !== "ollama") {
    throw new Error(`Provider '${id}' is not an Ollama provider (type: ${provider.type})`);
  }

  return provider as unknown as OllamaProvider;
}

// ── Handlers ─────────────────────────────────────────────────

async function handleOllamaModels(
  deps: OllamaToolDeps,
): Promise<McpToolResult> {
  const ollama = getOllamaProvider(deps);
  const models = ollama.getModels();

  if (models.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: "No models installed. Use `ollama_pull` to download a model.",
        },
      ],
    };
  }

  let text = `# Installed Ollama Models (${models.length})\n\n`;

  for (const model of models) {
    const sizeGB = (model.size / 1e9).toFixed(1);
    text += `## ${model.name}\n`;
    text += `- **Size:** ${sizeGB} GB\n`;
    if (model.strengths.length > 0) {
      text += `- **Strengths:** ${model.strengths.join(", ")}\n`;
    }
    text += "\n";
  }

  return { content: [{ type: "text", text }] };
}

async function handleOllamaPull(
  args: unknown,
  deps: OllamaToolDeps,
): Promise<McpToolResult> {
  const parsed = OllamaPullSchema.parse(args);

  // We need the Ollama provider to get the host; then call the Ollama API directly
  const ollama = getOllamaProvider(deps);

  // The OllamaProvider doesn't expose a pull method, so we call the API directly.
  // We use the provider's health check to get the host, but since the host
  // isn't directly exposed, we work around it by calling the API via the
  // provider. In practice, we POST to /api/pull.
  //
  // Since OllamaProvider doesn't expose its host, we perform the pull via
  // a chat-based workaround: we'll try to use the Ollama REST API.
  // For a clean implementation, we accept the host from deps or derive it.
  try {
    // Try to pull using Ollama's API - the provider exposes host indirectly
    // through health check, but we'll do a direct approach:
    // Cast to access internal host (or use a wrapper)
    const host = (ollama as any).host || "http://localhost:11434";
    const res = await fetch(`${host}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: parsed.model, stream: false }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      return {
        content: [
          {
            type: "text",
            text: `**Pull failed**\n**Model:** ${parsed.model}\n**Error:** HTTP ${res.status}: ${errorText}`,
          },
        ],
        isError: true,
      };
    }

    const data = await res.json() as any;
    return {
      content: [
        {
          type: "text",
          text: `**Model pulled successfully**\n**Model:** ${parsed.model}\n**Status:** ${data.status || "success"}`,
        },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text",
          text: `**Pull failed**\n**Model:** ${parsed.model}\n**Error:** ${message}`,
        },
      ],
      isError: true,
    };
  }
}

// ── Dispatcher ───────────────────────────────────────────────

export async function handleTool(
  name: string,
  args: unknown,
  deps: OllamaToolDeps,
): Promise<McpToolResult> {
  switch (name) {
    case "ollama_models":
      return handleOllamaModels(deps);
    case "ollama_pull":
      return handleOllamaPull(args, deps);
    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
}
