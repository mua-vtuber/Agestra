/**
 * ChatAdapter — Abstraction that routes provider.chat() calls based on
 * capability tier. Tool-tier Ollama providers are routed through AgentLoop
 * for multi-step agentic execution; all others use direct chat.
 */

import type { AIProvider, ChatRequest, ChatResponse } from "@agestra/core";
import { buildCapabilityProfile } from "@agestra/core";
import { AgentLoop } from "./agent-loop.js";
import type { AgentTool } from "./agent-tools.js";

// ── Interface ─────────────────────────────────────────────────

export interface ChatAdapter {
  chat(provider: AIProvider, request: ChatRequest): Promise<ChatResponse>;
}

// ── Config ────────────────────────────────────────────────────

export interface AgentLoopChatAdapterConfig {
  tools: AgentTool[];
  baseDir: string;
}

// ── Helpers ───────────────────────────────────────────────────

export interface OllamaConnectionInfo {
  host: string;
  model: string;
}

/**
 * Extract Ollama connection info from a provider if it's an OllamaProvider.
 * Returns null for non-Ollama providers or providers without getConnectionInfo().
 */
export function getOllamaConnectionInfo(provider: AIProvider): OllamaConnectionInfo | null {
  if (provider.type !== "ollama") return null;
  if (typeof (provider as any).getConnectionInfo === "function") {
    return (provider as any).getConnectionInfo();
  }
  return null;
}

// ── Implementation ────────────────────────────────────────────

export class AgentLoopChatAdapter implements ChatAdapter {
  private readonly tools: AgentTool[];
  private readonly baseDir: string;

  constructor(config: AgentLoopChatAdapterConfig) {
    this.tools = config.tools;
    this.baseDir = config.baseDir;
  }

  async chat(provider: AIProvider, request: ChatRequest): Promise<ChatResponse> {
    const profile = buildCapabilityProfile(provider.id, provider.getCapabilities());

    // Agent-tier providers: direct chat passthrough
    if (profile.tier !== "tool") {
      return provider.chat(request);
    }

    // Tool-tier but non-Ollama: no AgentLoop available, fall back to direct chat
    const connInfo = getOllamaConnectionInfo(provider);
    if (!connInfo) {
      return provider.chat(request);
    }

    // Tool-tier Ollama: route through AgentLoop for multi-step execution
    const loop = new AgentLoop({
      providerHost: connInfo.host,
      model: connInfo.model,
      baseDir: this.baseDir,
      tools: this.tools,
    });

    const result = await loop.run(request.prompt);
    return {
      text: result.output,
      model: connInfo.model,
      provider: provider.id,
    };
  }
}
