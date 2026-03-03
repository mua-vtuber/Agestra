import type {
  AIProvider,
  ChatRequest,
  ChatResponse,
  HealthStatus,
  ProviderCapability,
} from "@agestra/core";
import {
  ProviderUnavailableError,
  ProviderTimeoutError,
  ProviderExecutionError,
} from "@agestra/core";
import { detectModels, type DetectedModel } from "./model-detector.js";

export interface OllamaProviderConfig {
  id: string;
  host: string;
  defaultModel?: string;
  timeouts?: {
    default?: number;
    generate?: number;
    chat?: number;
  };
}

export class OllamaProvider implements AIProvider {
  readonly id: string;
  readonly type = "ollama";
  private host: string;
  private defaultModel: string;
  private available = false;
  private models: DetectedModel[] = [];
  private timeouts: { default: number; generate: number; chat: number };

  constructor(config: OllamaProviderConfig) {
    this.id = config.id;
    this.host = config.host;
    this.defaultModel = config.defaultModel || "auto";
    this.timeouts = {
      default: config.timeouts?.default ?? 30_000,
      generate: config.timeouts?.generate ?? 300_000,
      chat: config.timeouts?.chat ?? 300_000,
    };
  }

  async initialize(): Promise<void> {
    try {
      this.models = await detectModels(this.host);
      this.available = this.models.length > 0;
    } catch {
      this.available = false;
    }
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      const res = await fetch(`${this.host}/api/tags`);
      if (!res.ok) return { status: "error", message: `HTTP ${res.status}` };
      const data = (await res.json()) as any;
      const modelCount = data.models?.length ?? 0;
      return {
        status: modelCount > 0 ? "ok" : "degraded",
        message: `${modelCount} models available`,
        details: { models: data.models?.map((m: any) => m.name) },
      };
    } catch (err) {
      return { status: "error", message: (err as Error).message };
    }
  }

  getCapabilities(): ProviderCapability {
    return {
      maxContext: 32768,
      supportsSystemPrompt: true,
      supportsFiles: false,
      supportsStreaming: true,
      supportsJsonOutput: false,
      supportsToolUse: true,
      strengths: [...new Set(this.models.flatMap((m) => m.strengths))],
      models: this.models.map((m) => ({
        name: m.name,
        description: `Ollama model (${Math.round(m.size / 1e9)}GB)`,
        strengths: m.strengths,
      })),
    };
  }

  isAvailable(): boolean {
    return this.available;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (!this.available) {
      throw new ProviderUnavailableError(
        this.id,
        "Ollama not running or no models installed",
      );
    }

    const model = request.model || this.selectModel();
    const body = {
      model,
      prompt: request.prompt,
      system: request.system || "You are a helpful assistant.",
      stream: false,
      ...(request.extra || {}),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeouts.generate);

    try {
      const res = await fetch(`${this.host}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.status === 429) {
        this.available = false;
        throw new ProviderUnavailableError(
          this.id,
          "Rate limited (429) — provider deactivated",
        );
      }
      if (!res.ok) {
        throw new ProviderExecutionError(
          this.id,
          `HTTP ${res.status}: ${res.statusText}`,
        );
      }
      const data = (await res.json()) as any;
      return {
        text: data.response,
        model: data.model || model,
        provider: this.id,
      };
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new ProviderTimeoutError(this.id, this.timeouts.generate);
      }
      if (err instanceof ProviderExecutionError || err instanceof ProviderUnavailableError) throw err;
      throw new ProviderExecutionError(this.id, (err as Error).message);
    } finally {
      clearTimeout(timer);
    }
  }

  private selectModel(): string {
    if (this.defaultModel !== "auto") return this.defaultModel;
    return this.models[0]?.name || "llama3";
  }

  getModels(): DetectedModel[] {
    return [...this.models];
  }
}
