import { randomUUID } from "crypto";
import type { AIProvider, ProviderRegistry } from "@agestra/core";
import type { ChatAdapter } from "./chat-adapter.js";
import { extractJsonFromText } from "./json-parser.js";

// ── Types ────────────────────────────────────────────────────

export interface TaskStep {
  id: string;
  description: string;
  prompt: string;
  provider: string;
  dependsOn?: string[];
  checkpoint?: boolean;
  validation?: string;
}

export interface StepResult {
  stepId: string;
  provider: string;
  output: string;
  status: "completed" | "error" | "skipped";
  validationResult?: { passed: boolean; feedback: string };
  startedAt: string;
  completedAt: string;
}

export interface TaskChainState {
  id: string;
  steps: TaskStep[];
  results: StepResult[];
  currentStepIndex: number;
  status: "created" | "running" | "paused" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
}

export interface TaskChainCreateConfig {
  steps: TaskStep[];
}

// ── Engine ───────────────────────────────────────────────────

export class TaskChainEngine {
  private chains = new Map<string, TaskChainState>();

  constructor(
    private chatAdapter: ChatAdapter,
    private registry: ProviderRegistry,
  ) {}

  create(config: TaskChainCreateConfig): TaskChainState {
    const id = randomUUID();
    const now = new Date().toISOString();
    const state: TaskChainState = {
      id,
      steps: config.steps,
      results: [],
      currentStepIndex: 0,
      status: "created",
      createdAt: now,
      updatedAt: now,
    };
    this.chains.set(id, state);
    return state;
  }

  getState(chainId: string): TaskChainState | undefined {
    return this.chains.get(chainId);
  }

  delete(chainId: string): boolean {
    return this.chains.delete(chainId);
  }

  /**
   * Execute the next (or specified) step in the chain.
   * If overridePrompt is given, it replaces the step's original prompt.
   */
  async executeStep(
    chainId: string,
    stepId?: string,
    overridePrompt?: string,
  ): Promise<StepResult> {
    const state = this.chains.get(chainId);
    if (!state) throw new Error(`Chain not found: ${chainId}`);
    if (state.status === "completed" || state.status === "failed") {
      throw new Error(`Chain already ${state.status}: ${chainId}`);
    }

    // Determine which step to execute
    const step = stepId
      ? state.steps.find((s) => s.id === stepId)
      : state.steps[state.currentStepIndex];

    if (!step) {
      throw new Error(stepId ? `Step not found: ${stepId}` : "No more steps to execute");
    }

    // Check dependencies
    const completedStepIds = new Set(
      state.results.filter((r) => r.status === "completed").map((r) => r.stepId),
    );
    if (step.dependsOn) {
      const unmet = step.dependsOn.filter((dep) => !completedStepIds.has(dep));
      if (unmet.length > 0) {
        throw new Error(`Unmet dependencies for step "${step.id}": ${unmet.join(", ")}`);
      }
    }

    // Build prompt with context from previous results
    const contextPrompt = this.buildContextPrompt(state, step, overridePrompt);

    // Mark chain as running
    state.status = "running";
    state.updatedAt = new Date().toISOString();

    const startedAt = new Date().toISOString();

    // Resolve provider (skip "claude" — it's the host)
    let output: string;
    try {
      if (step.provider === "claude") {
        // Claude steps are recorded directly — the caller provides content via overridePrompt
        output = overridePrompt ?? step.prompt;
      } else {
        const provider = this.registry.get(step.provider);
        const response = await this.chatAdapter.chat(provider, { prompt: contextPrompt });
        output = response.text;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const errorResult: StepResult = {
        stepId: step.id,
        provider: step.provider,
        output: message,
        status: "error",
        startedAt,
        completedAt: new Date().toISOString(),
      };
      state.results.push(errorResult);
      state.status = "failed";
      state.updatedAt = new Date().toISOString();
      return errorResult;
    }

    // Run validation if specified
    let validationResult: { passed: boolean; feedback: string } | undefined;
    if (step.validation) {
      validationResult = await this.validateStepOutput(state, step, output);
    }

    const result: StepResult = {
      stepId: step.id,
      provider: step.provider,
      output,
      status: "completed",
      validationResult,
      startedAt,
      completedAt: new Date().toISOString(),
    };
    state.results.push(result);

    // Advance step index
    const stepIndex = state.steps.findIndex((s) => s.id === step.id);
    if (stepIndex >= state.currentStepIndex) {
      state.currentStepIndex = stepIndex + 1;
    }

    // Determine chain status
    if (state.currentStepIndex >= state.steps.length) {
      state.status = "completed";
    } else if (step.checkpoint) {
      state.status = "paused";
    } else {
      state.status = "running";
    }

    state.updatedAt = new Date().toISOString();
    return result;
  }

  private buildContextPrompt(
    state: TaskChainState,
    step: TaskStep,
    overridePrompt?: string,
  ): string {
    const basePrompt = overridePrompt ?? step.prompt;

    // Collect results from dependencies (or all previous if no deps specified)
    const relevantResults = step.dependsOn
      ? state.results.filter((r) => step.dependsOn!.includes(r.stepId) && r.status === "completed")
      : state.results.filter((r) => r.status === "completed");

    if (relevantResults.length === 0) return basePrompt;

    let context = "=== Previous Results ===\n\n";
    for (const r of relevantResults) {
      const stepDef = state.steps.find((s) => s.id === r.stepId);
      context += `[Step ${r.stepId}] ${stepDef?.description ?? ""}:\n${r.output}\n\n`;
    }
    context += "===\n\n";

    return context + basePrompt;
  }

  private async validateStepOutput(
    state: TaskChainState,
    step: TaskStep,
    output: string,
  ): Promise<{ passed: boolean; feedback: string }> {
    // Use the same provider for validation, or first available agent-tier
    try {
      const provider = this.registry.get(step.provider);
      const validationPrompt = `${step.validation}\n\nOutput to validate:\n${output}\n\nRespond with JSON: { "passed": true/false, "feedback": "..." }`;
      const response = await this.chatAdapter.chat(provider, { prompt: validationPrompt });

      const parsed = extractJsonFromText(response.text) as Record<string, unknown> | null;
      if (parsed) {
        return {
          passed: Boolean(parsed.passed),
          feedback: String(parsed.feedback ?? ""),
        };
      }
      return { passed: true, feedback: response.text };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { passed: false, feedback: `Validation skipped (provider error: ${message})` };
    }
  }
}
