import type {
  AIProvider,
  ChatRequest,
  ChatResponse,
  HealthStatus,
  ProviderCapability,
} from "@agestra/core";
import {
  runCli,
  ProviderUnavailableError,
  ProviderTimeoutError,
  ProviderExecutionError,
} from "@agestra/core";
import { parseCodexOutput } from "./output-parser.js";

export interface CodexProviderConfig {
  id: string;
  timeout?: number;
}

export class CodexProvider implements AIProvider {
  readonly id: string;
  readonly type = "codex-cli";
  private timeout: number;
  private available = false;
  private cliPath: string | null = null;

  constructor(config: CodexProviderConfig) {
    this.id = config.id;
    this.timeout = config.timeout ?? 120_000;
  }

  async initialize(): Promise<void> {
    try {
      // Check if codex CLI is available directly
      const result = await runCli({
        command: "codex",
        args: ["--version"],
        timeout: 10_000,
      });
      this.available = result.exitCode === 0;
      this.cliPath = "codex";
    } catch {
      // Try npx path as fallback
      try {
        const result = await runCli({
          command: "npx",
          args: ["@openai/codex", "--version"],
          timeout: 30_000,
        });
        this.available = result.exitCode === 0;
        this.cliPath = "npx";
      } catch {
        this.available = false;
      }
    }
  }

  async healthCheck(): Promise<HealthStatus> {
    if (!this.available) {
      return { status: "error", message: "Codex CLI not installed" };
    }
    try {
      const cmd = this.cliPath === "npx" ? "npx" : "codex";
      const args =
        this.cliPath === "npx"
          ? ["@openai/codex", "--version"]
          : ["--version"];
      const result = await runCli({ command: cmd, args, timeout: 10_000 });
      return result.exitCode === 0
        ? { status: "ok", message: "Codex CLI available" }
        : { status: "error", message: `Exit code: ${result.exitCode}` };
    } catch (err) {
      return { status: "error", message: (err as Error).message };
    }
  }

  getCapabilities(): ProviderCapability {
    return {
      maxContext: 128_000,
      supportsSystemPrompt: true,
      supportsFiles: true,
      supportsStreaming: false,
      supportsJsonOutput: true,
      supportsToolUse: true,
      strengths: ["code_generation", "code_review", "autonomous_execution"],
      models: [
        {
          name: "codex",
          description: "OpenAI Codex CLI",
          strengths: ["code_generation"],
        },
      ],
    };
  }

  isAvailable(): boolean {
    return this.available;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (!this.available) {
      throw new ProviderUnavailableError(this.id, "Codex CLI not installed");
    }

    // Build prompt with system message
    let fullPrompt = request.prompt;
    if (request.system) {
      fullPrompt = `${request.system}\n\n${fullPrompt}`;
    }

    // Add file references
    if (request.files?.length) {
      for (const f of request.files) {
        if (f.content) {
          fullPrompt += `\n\n### File: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``;
        }
      }
    }

    const baseArgs = ["exec", "--full-auto", "--ephemeral", "--json", fullPrompt];
    const cmd = this.cliPath === "npx" ? "npx" : "codex";
    const cliArgs =
      this.cliPath === "npx" ? ["@openai/codex", ...baseArgs] : baseArgs;

    try {
      const result = await runCli({
        command: cmd,
        args: cliArgs,
        timeout: this.timeout,
      });

      if (result.exitCode !== 0) {
        const errMsg = result.stderr.trim() || `Exit code ${result.exitCode}`;
        const errLower = errMsg.toLowerCase();
        if (
          errLower.includes("429") ||
          errLower.includes("rate limit") ||
          errLower.includes("quota")
        ) {
          this.available = false;
          throw new ProviderUnavailableError(
            this.id,
            `Rate limited: ${errMsg}`,
          );
        }
        if (
          errLower.includes("auth") ||
          errLower.includes("credential") ||
          errLower.includes("login") ||
          errLower.includes("api key")
        ) {
          throw new ProviderUnavailableError(
            this.id,
            `Authentication issue: ${errMsg}`,
          );
        }
        throw new ProviderExecutionError(this.id, errMsg);
      }

      const text = parseCodexOutput(result.stdout);
      return {
        text,
        model: "codex",
        provider: this.id,
      };
    } catch (err) {
      if (
        err instanceof ProviderUnavailableError ||
        err instanceof ProviderExecutionError
      ) {
        throw err;
      }
      if ((err as Error).message?.includes("timeout")) {
        throw new ProviderTimeoutError(this.id, this.timeout);
      }
      throw new ProviderExecutionError(this.id, (err as Error).message);
    }
  }
}
