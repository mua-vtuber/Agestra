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
import { filterGeminiOutput, parseGeminiJsonOutput } from "./output-parser.js";

export interface GeminiProviderConfig {
  id: string;
  timeout?: number;
}

export class GeminiProvider implements AIProvider {
  readonly id: string;
  readonly type = "gemini-cli";
  private timeout: number;
  private available = false;
  private cliPath: string | null = null;

  constructor(config: GeminiProviderConfig) {
    this.id = config.id;
    this.timeout = config.timeout ?? 120_000;
  }

  async initialize(): Promise<void> {
    try {
      // Check if gemini CLI is available directly
      const result = await runCli({
        command: "gemini",
        args: ["--version"],
        timeout: 10_000,
      });
      this.available = result.exitCode === 0;
      this.cliPath = "gemini";
    } catch {
      // Try npx path as fallback
      try {
        const result = await runCli({
          command: "npx",
          args: ["gemini", "--version"],
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
      return { status: "error", message: "Gemini CLI not installed" };
    }
    try {
      const cmd = this.cliPath === "npx" ? "npx" : "gemini";
      const args = this.cliPath === "npx" ? ["gemini", "--version"] : ["--version"];
      const result = await runCli({ command: cmd, args, timeout: 10_000 });
      return result.exitCode === 0
        ? { status: "ok", message: "Gemini CLI available" }
        : { status: "error", message: `Exit code: ${result.exitCode}` };
    } catch (err) {
      return { status: "error", message: (err as Error).message };
    }
  }

  getCapabilities(): ProviderCapability {
    return {
      maxContext: 1_000_000,
      supportsSystemPrompt: true,
      supportsFiles: true,
      supportsStreaming: false,
      supportsJsonOutput: true,
      supportsToolUse: false,
      strengths: ["long_context", "file_analysis", "translation", "summarization"],
      models: [
        {
          name: "gemini-2.5-pro",
          description: "Google Gemini 2.5 Pro via CLI",
          strengths: ["long_context", "reasoning"],
        },
      ],
    };
  }

  isAvailable(): boolean {
    return this.available;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (!this.available) {
      throw new ProviderUnavailableError(this.id, "Gemini CLI not installed");
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

    // Use -p for non-interactive mode, -o json for structured output
    const args = ["-p", fullPrompt, "-o", "json"];
    const cmd = this.cliPath === "npx" ? "npx" : "gemini";
    const cliArgs = this.cliPath === "npx" ? ["gemini", ...args] : args;

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

      // Try JSON parse first (-o json gives structured output)
      const jsonResponse = parseGeminiJsonOutput(result.stdout);
      if (jsonResponse !== null) {
        // Extract model name from stats if available
        const model = extractModelName(result.stdout);
        return {
          text: jsonResponse,
          model,
          provider: this.id,
        };
      }

      // Fallback: filter noise from text output
      const text = filterGeminiOutput(result.stdout);
      return {
        text,
        model: "gemini",
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

/**
 * Extract the main model name from Gemini CLI JSON output stats.
 * Looks for the "main" role model in stats.models.
 */
function extractModelName(output: string): string {
  try {
    const parsed = JSON.parse(output.trim());
    if (parsed?.stats?.models) {
      for (const [name, info] of Object.entries(parsed.stats.models)) {
        if ((info as any)?.roles?.main) {
          return name;
        }
      }
      // Fallback: return first model name
      const names = Object.keys(parsed.stats.models);
      if (names.length > 0) return names[0];
    }
  } catch {
    /* not JSON */
  }
  return "gemini";
}
