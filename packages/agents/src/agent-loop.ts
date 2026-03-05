/**
 * AgentLoop — Multi-step tool-calling engine for Ollama.
 *
 * Manages a conversation loop with Ollama's /api/chat endpoint,
 * providing sandboxed tools (file_read, file_write, etc.) so that
 * tool-tier providers can perform agentic multi-step tasks.
 */

import { createDefaultTools, toOllamaToolDefs } from "./agent-tools.js";
import type { AgentTool, OllamaToolDefinition } from "./agent-tools.js";
import { extractJSON } from "./json-parser.js";

// ── Types ────────────────────────────────────────────────────

export interface AgentLoopConfig {
  providerHost: string;
  model: string;
  baseDir: string;
  maxIterations?: number;
  timeoutMs?: number;
  tools?: AgentTool[];
}

export interface AgentLoopResult {
  success: boolean;
  output: string;
  iterations: number;
  toolCalls: ToolCallRecord[];
  error?: string;
}

export interface ToolCallRecord {
  iteration: number;
  toolName: string;
  arguments: Record<string, unknown>;
  result: string;
  durationMs: number;
}

export interface AgentLoopFactory {
  create(providerId: string): AgentLoop | null;
}

// ── Ollama /api/chat types ───────────────────────────────────

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
}

interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown> | string;
  };
}

interface OllamaChatResponse {
  message: OllamaMessage;
}

// ── Constants ────────────────────────────────────────────────

const DEFAULT_MAX_ITERATIONS = 15;
const MAX_MAX_ITERATIONS = 30;
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

const SYSTEM_PROMPT = `You are a coding assistant with access to tools for reading, writing, and searching files in a workspace. Use the provided tools when you need to inspect or modify code. When your task is complete, respond with your final answer without making any tool calls.

Guidelines:
- Read files before modifying them to understand the existing code.
- Use grep_search to find relevant code across the workspace.
- Write complete file contents when using file_write (not just diffs).
- Provide a clear summary of what you did when finished.`;

// ── AgentLoop ────────────────────────────────────────────────

export class AgentLoop {
  private readonly host: string;
  private readonly model: string;
  private readonly baseDir: string;
  private readonly maxIterations: number;
  private readonly timeoutMs: number;
  private readonly tools: AgentTool[];
  private readonly toolDefs: OllamaToolDefinition[];
  private readonly toolMap: Map<string, AgentTool>;

  constructor(config: AgentLoopConfig) {
    this.host = config.providerHost.replace(/\/$/, "");
    this.model = config.model;
    this.baseDir = config.baseDir;
    this.maxIterations = Math.min(
      config.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      MAX_MAX_ITERATIONS,
    );
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.tools = config.tools ?? createDefaultTools();
    this.toolDefs = toOllamaToolDefs(this.tools);
    this.toolMap = new Map(this.tools.map((t) => [t.name, t]));
  }

  async run(task: string): Promise<AgentLoopResult> {
    const startTime = Date.now();
    const toolCalls: ToolCallRecord[] = [];
    let accumulatedOutput = "";

    const messages: OllamaMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: task },
    ];

    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      // Check global timeout
      if (Date.now() - startTime > this.timeoutMs) {
        return {
          success: false,
          output: accumulatedOutput || "Agent loop timed out before completion.",
          iterations: iteration,
          toolCalls,
          error: `Timed out after ${this.timeoutMs}ms`,
        };
      }

      // Call Ollama /api/chat
      let response: OllamaChatResponse;
      try {
        response = await this.callOllama(messages);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          output: accumulatedOutput || "",
          iterations: iteration,
          toolCalls,
          error: `Ollama API error: ${errorMsg}`,
        };
      }

      const assistantMsg = response.message;

      // Collect any text output
      if (assistantMsg.content) {
        accumulatedOutput = assistantMsg.content;
      }

      // No tool calls → model is done
      if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
        return {
          success: true,
          output: accumulatedOutput,
          iterations: iteration + 1,
          toolCalls,
        };
      }

      // Append assistant message to conversation
      messages.push(assistantMsg);

      // Execute each tool call
      for (const tc of assistantMsg.tool_calls) {
        const toolName = tc.function.name;
        const rawArgs = tc.function.arguments;

        // Parse arguments — may be string or object depending on model
        let parsedArgs: Record<string, unknown>;
        if (typeof rawArgs === "string") {
          const extracted = extractJSON(rawArgs);
          parsedArgs = (extracted && typeof extracted === "object" && !Array.isArray(extracted))
            ? extracted as Record<string, unknown>
            : {};
        } else {
          parsedArgs = rawArgs ?? {};
        }

        const tool = this.toolMap.get(toolName);
        const callStart = Date.now();

        let result: string;
        if (!tool) {
          result = `Error: unknown tool '${toolName}'. Available tools: ${[...this.toolMap.keys()].join(", ")}`;
        } else {
          try {
            result = await tool.execute(parsedArgs, this.baseDir);
          } catch (err) {
            result = `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        toolCalls.push({
          iteration,
          toolName,
          arguments: parsedArgs,
          result: result.length > 2000 ? result.slice(0, 2000) + "... [truncated in log]" : result,
          durationMs: Date.now() - callStart,
        });

        // Append tool result to conversation
        messages.push({
          role: "tool",
          content: result,
        });
      }
    }

    // Max iterations reached
    return {
      success: false,
      output: accumulatedOutput || "Agent loop reached max iterations without completing.",
      iterations: this.maxIterations,
      toolCalls,
      error: `Max iterations (${this.maxIterations}) reached`,
    };
  }

  private async callOllama(messages: OllamaMessage[]): Promise<OllamaChatResponse> {
    const url = `${this.host}/api/chat`;
    const body = {
      model: this.model,
      messages,
      tools: this.toolDefs,
      stream: false,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }

      return (await res.json()) as OllamaChatResponse;
    } finally {
      clearTimeout(timeout);
    }
  }
}
