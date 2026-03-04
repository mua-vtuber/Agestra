import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { ProviderRegistry, JobManager } from "@agestra/core";
import type { TraceWriter } from "@agestra/core";
import type { SessionManager } from "@agestra/agents";
import type { DocumentManager } from "@agestra/workspace";
import type { MemoryFacade } from "@agestra/memory";

import * as aiChat from "./tools/ai-chat.js";
import * as agentSession from "./tools/agent-session.js";
import * as workspace from "./tools/workspace.js";
import * as providerManage from "./tools/provider-manage.js";
import * as ollamaManage from "./tools/ollama-manage.js";
import * as memory from "./tools/memory.js";
import * as jobs from "./tools/jobs.js";
import * as trace from "./tools/trace.js";

// ── Types ─────────────────────────────────────────────────────

export interface ServerDependencies {
  registry: ProviderRegistry;
  sessionManager: SessionManager;
  documentManager: DocumentManager;
  memoryFacade: MemoryFacade;
  jobManager: JobManager;
  traceWriter?: TraceWriter;
}

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// ── Constants ─────────────────────────────────────────────────

const MAX_RESPONSE_BYTES = 50 * 1024; // 50 KB

// ── Tool module registry ──────────────────────────────────────

interface ToolModule {
  getTools: () => Array<{
    name: string;
    description: string;
    inputSchema: object;
  }>;
  handleTool: (name: string, args: unknown, deps: any) => Promise<McpToolResult>;
}

const TOOL_MODULES: ToolModule[] = [
  aiChat,
  agentSession,
  workspace,
  providerManage,
  ollamaManage,
  memory,
  jobs,
  trace,
];

// ── Collect all tool definitions ──────────────────────────────

export function collectTools(): Array<{
  name: string;
  description: string;
  inputSchema: object;
}> {
  const tools: Array<{ name: string; description: string; inputSchema: object }> = [];
  for (const mod of TOOL_MODULES) {
    tools.push(...mod.getTools());
  }
  return tools;
}

// ── Build dispatch map: tool name -> module ───────────────────

function buildDispatchMap(): Map<string, ToolModule> {
  const map = new Map<string, ToolModule>();
  for (const mod of TOOL_MODULES) {
    for (const tool of mod.getTools()) {
      map.set(tool.name, mod);
    }
  }
  return map;
}

let _cachedDispatchMap: Map<string, ToolModule> | null = null;
function getDispatchMap(): Map<string, ToolModule> {
  if (!_cachedDispatchMap) _cachedDispatchMap = buildDispatchMap();
  return _cachedDispatchMap;
}

// ── Response truncation ───────────────────────────────────────

export function truncateResponse(result: McpToolResult): McpToolResult {
  const content = result.content.map((item) => {
    if (item.type === "text" && Buffer.byteLength(item.text, "utf-8") > MAX_RESPONSE_BYTES) {
      const truncated = Buffer.from(item.text, "utf-8")
        .subarray(0, MAX_RESPONSE_BYTES)
        .toString("utf-8");
      return {
        type: "text" as const,
        text: truncated + "\n\n... [Response truncated at 50KB]",
      };
    }
    return item;
  });
  return { ...result, content };
}

// ── Dispatch ──────────────────────────────────────────────────

export async function dispatch(
  toolName: string,
  args: unknown,
  deps: ServerDependencies,
): Promise<McpToolResult> {
  const dispatchMap = getDispatchMap();
  const mod = dispatchMap.get(toolName);

  if (!mod) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
      isError: true,
    };
  }

  // Build deps appropriate for the module.
  // All modules accept at least { registry }, and some need additional deps.
  // We pass the superset; each module picks what it needs.
  const moduleDeps = {
    registry: deps.registry,
    sessionManager: deps.sessionManager,
    documentManager: deps.documentManager,
    memoryFacade: deps.memoryFacade,
    jobManager: deps.jobManager,
    traceWriter: deps.traceWriter,
  };

  const result = await mod.handleTool(toolName, args, moduleDeps);
  return truncateResponse(result);
}

// ── Server factory ────────────────────────────────────────────

export function createServer(deps: ServerDependencies): Server {
  const server = new Server(
    { name: "agestra", version: "4.0.0" },
    { capabilities: { tools: {} } },
  );

  // List all tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: collectTools() };
  });

  // Dispatch tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request, _extra): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    try {
      const result = await dispatch(name, args ?? {}, deps);
      return { content: result.content, isError: result.isError };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// ── Connect helper ────────────────────────────────────────────

export async function connectStdio(server: Server): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
