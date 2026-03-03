export interface FileReference {
  path: string;
  content?: string;
}

export interface ChatRequest {
  prompt: string;
  system?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  files?: FileReference[];
  extra?: Record<string, unknown>;
}

export interface ChatResponse {
  text: string;
  model: string;
  provider: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  metadata?: Record<string, unknown>;
}

export interface ModelInfo {
  name: string;
  description: string;
  strengths: string[];
}

export interface ProviderCapability {
  maxContext: number;
  supportsSystemPrompt: boolean;
  supportsFiles: boolean;
  supportsStreaming: boolean;
  supportsJsonOutput: boolean;
  supportsToolUse: boolean;
  strengths: string[];
  models: ModelInfo[];
}

export interface HealthStatus {
  status: "ok" | "degraded" | "error";
  message?: string;
  details?: Record<string, unknown>;
}

export interface AIProvider {
  readonly id: string;
  readonly type: string;
  initialize(): Promise<void>;
  healthCheck(): Promise<HealthStatus>;
  getCapabilities(): ProviderCapability;
  isAvailable(): boolean;
  chat(request: ChatRequest): Promise<ChatResponse>;
  streamChat?(request: ChatRequest): AsyncIterable<ChatResponse>;
}
