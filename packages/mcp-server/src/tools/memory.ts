import { z } from "zod";
import type { MemoryFacade } from "@agestra/memory";

// ── Zod schemas ──────────────────────────────────────────────

const MemorySearchSchema = z.object({
  query: z.string().describe("Search query for memory retrieval"),
  top_k: z.number().int().positive().optional().default(10).describe("Max results to return (default: 10)"),
});

const MemoryIndexSchema = z.object({
  paths: z.array(z.string()).min(1).describe("File or directory paths to index"),
});

const MemoryStoreSchema = z.object({
  content: z.string().describe("Content to store as a memory node"),
  node_type: z.enum(["fact", "decision", "preference", "insight", "dead_end", "finding"]).describe("Type of knowledge node"),
  topic: z.enum(["technical", "decisions", "preferences", "context"]).describe("Topic category"),
  importance: z.number().min(0).max(1).describe("Importance score (0-1)"),
  provider_id: z.string().optional().describe("Provider ID that produced this knowledge"),
});

const MemoryDeadEndsSchema = z.object({
  query: z.string().describe("Search query to find previously failed approaches"),
});

const MemoryContextSchema = z.object({
  query: z.string().describe("Query to assemble context for"),
  token_budget: z.number().int().positive().optional().describe("Maximum tokens for assembled context"),
});

const MemoryAddEdgeSchema = z.object({
  source_id: z.string().describe("Source node ID"),
  target_id: z.string().describe("Target node ID"),
  relation_type: z.enum(["related_to", "contradicts", "supersedes", "depends_on", "merged_from", "derived_from"]).describe("Relationship type between nodes"),
});

// ── Types ────────────────────────────────────────────────────

export interface MemoryToolDeps {
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
      name: "memory_search",
      description:
        "Search the memory system using hybrid retrieval (FTS5 + vector + graph). Returns scored results sorted by relevance.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Search query for memory retrieval" },
          top_k: {
            type: "number",
            description: "Max results to return (default: 10)",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "memory_index",
      description:
        "Index files or directories into the memory system for later retrieval.",
      inputSchema: {
        type: "object" as const,
        properties: {
          paths: {
            type: "array",
            items: { type: "string" },
            description: "File or directory paths to index",
          },
        },
        required: ["paths"],
      },
    },
    {
      name: "memory_store",
      description:
        "Store a knowledge node in the memory system. Supports any node type including dead_end and finding.",
      inputSchema: {
        type: "object" as const,
        properties: {
          content: { type: "string", description: "Content to store as a memory node" },
          node_type: {
            type: "string",
            enum: ["fact", "decision", "preference", "insight", "dead_end", "finding"],
            description: "Type of knowledge node",
          },
          topic: {
            type: "string",
            enum: ["technical", "decisions", "preferences", "context"],
            description: "Topic category",
          },
          importance: {
            type: "number",
            description: "Importance score (0-1)",
          },
          provider_id: {
            type: "string",
            description: "Provider ID that produced this knowledge",
          },
        },
        required: ["content", "node_type", "topic", "importance"],
      },
    },
    {
      name: "memory_dead_ends",
      description:
        "Search for previously recorded dead-end approaches. Use before starting work to avoid repeating failed strategies.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Search query to find previously failed approaches" },
        },
        required: ["query"],
      },
    },
    {
      name: "memory_context",
      description:
        "Assemble relevant memory context for a query, ready for prompt injection. Uses hybrid retrieval and reranking.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Query to assemble context for" },
          token_budget: {
            type: "number",
            description: "Maximum tokens for assembled context",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "memory_add_edge",
      description:
        "Create a relationship edge between two knowledge nodes in the memory graph.",
      inputSchema: {
        type: "object" as const,
        properties: {
          source_id: { type: "string", description: "Source node ID" },
          target_id: { type: "string", description: "Target node ID" },
          relation_type: {
            type: "string",
            enum: ["related_to", "contradicts", "supersedes", "depends_on", "merged_from", "derived_from"],
            description: "Relationship type between nodes",
          },
        },
        required: ["source_id", "target_id", "relation_type"],
      },
    },
  ];
}

// ── Handlers ─────────────────────────────────────────────────

async function handleMemorySearch(
  args: unknown,
  deps: MemoryToolDeps,
): Promise<McpToolResult> {
  const parsed = MemorySearchSchema.parse(args);

  const results = await deps.memoryFacade.search(parsed.query, {
    limit: parsed.top_k,
  });

  if (results.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: `No results found for query: "${parsed.query}"`,
        },
      ],
    };
  }

  let text = `# Memory Search Results\n\n`;
  text += `**Query:** ${parsed.query}\n`;
  text += `**Results:** ${results.length}\n\n`;

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    text += `## ${i + 1}. [Score: ${r.score.toFixed(3)}]\n`;
    text += `- **ID:** ${r.node.id}\n`;
    text += `- **Type:** ${r.node.nodeType}\n`;
    text += `- **Topic:** ${r.node.topic}\n`;
    text += `- **Content:** ${r.node.content}\n\n`;
  }

  return { content: [{ type: "text", text }] };
}

async function handleMemoryIndex(
  args: unknown,
  deps: MemoryToolDeps,
): Promise<McpToolResult> {
  const parsed = MemoryIndexSchema.parse(args);

  let indexed = 0;
  const errors: string[] = [];

  for (const filePath of parsed.paths) {
    try {
      // Index each file as a knowledge node
      deps.memoryFacade.store({
        content: `Indexed file: ${filePath}`,
        nodeType: "fact",
        topic: "context",
        importance: 0.5,
        source: "auto",
      });
      indexed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${filePath}: ${msg}`);
    }
  }

  let text = `**Indexing complete**\n`;
  text += `- **Indexed:** ${indexed} path(s)\n`;
  text += `- **Errors:** ${errors.length}\n`;

  if (errors.length > 0) {
    text += `\n**Errors:**\n`;
    for (const e of errors) {
      text += `- ${e}\n`;
    }
  }

  return {
    content: [{ type: "text", text }],
    isError: errors.length > 0 && indexed === 0 ? true : undefined,
  };
}

async function handleMemoryStore(
  args: unknown,
  deps: MemoryToolDeps,
): Promise<McpToolResult> {
  const parsed = MemoryStoreSchema.parse(args);

  const id = deps.memoryFacade.store({
    content: parsed.content,
    nodeType: parsed.node_type,
    topic: parsed.topic,
    importance: parsed.importance,
    source: "auto",
    providerId: parsed.provider_id,
  });

  return {
    content: [
      {
        type: "text",
        text: `**Node stored**\n- **ID:** ${id}\n- **Type:** ${parsed.node_type}\n- **Topic:** ${parsed.topic}\n- **Importance:** ${parsed.importance}`,
      },
    ],
  };
}

async function handleMemoryDeadEnds(
  args: unknown,
  deps: MemoryToolDeps,
): Promise<McpToolResult> {
  const parsed = MemoryDeadEndsSchema.parse(args);

  const results = await deps.memoryFacade.search(parsed.query, {
    nodeType: "dead_end",
  });

  if (results.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: `No dead-end records found for query: "${parsed.query}"`,
        },
      ],
    };
  }

  let text = `# Dead-End Records\n\n`;
  text += `**Query:** ${parsed.query}\n`;
  text += `**Results:** ${results.length}\n\n`;

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    text += `## ${i + 1}. [Score: ${r.score.toFixed(3)}]\n`;
    text += `- **ID:** ${r.node.id}\n`;
    text += `- **Content:** ${r.node.content}\n\n`;
  }

  return { content: [{ type: "text", text }] };
}

async function handleMemoryContext(
  args: unknown,
  deps: MemoryToolDeps,
): Promise<McpToolResult> {
  const parsed = MemoryContextSchema.parse(args);

  const ctx = await deps.memoryFacade.getAssembledContext({
    query: parsed.query,
  });

  return {
    content: [
      {
        type: "text",
        text: `# Assembled Context\n\n**Query:** ${parsed.query}\n**Tokens used:** ${ctx.tokensUsed}\n\n---\n\n${ctx.memoryContext}`,
      },
    ],
  };
}

async function handleMemoryAddEdge(
  args: unknown,
  deps: MemoryToolDeps,
): Promise<McpToolResult> {
  const parsed = MemoryAddEdgeSchema.parse(args);

  const edgeId = deps.memoryFacade.addEdge(
    parsed.source_id,
    parsed.target_id,
    parsed.relation_type,
  );

  return {
    content: [
      {
        type: "text",
        text: `**Edge created**\n- **Edge ID:** ${edgeId}\n- **Source:** ${parsed.source_id}\n- **Target:** ${parsed.target_id}\n- **Relation:** ${parsed.relation_type}`,
      },
    ],
  };
}

// ── Dispatcher ───────────────────────────────────────────────

export async function handleTool(
  name: string,
  args: unknown,
  deps: MemoryToolDeps,
): Promise<McpToolResult> {
  switch (name) {
    case "memory_search":
      return handleMemorySearch(args, deps);
    case "memory_index":
      return handleMemoryIndex(args, deps);
    case "memory_store":
      return handleMemoryStore(args, deps);
    case "memory_dead_ends":
      return handleMemoryDeadEnds(args, deps);
    case "memory_context":
      return handleMemoryContext(args, deps);
    case "memory_add_edge":
      return handleMemoryAddEdge(args, deps);
    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
}
