import type { AIProvider, ProviderRegistry, ChatRequest, ChatResponse } from "@agestra/core";
import type { ChatAdapter } from "./chat-adapter.js";
import { extractJsonFromText } from "./json-parser.js";

export interface CrossValidationItem {
  providerId: string;
  content: string;
  task: string;
}

export interface CrossValidationConfig {
  items: CrossValidationItem[];
  validators?: AIProvider[];
  criteria?: string;
}

export interface ReviewResult {
  targetProvider: string;
  reviewerProvider: string;
  passed: boolean;
  feedback: string;
  suggestedFixes?: string;
}

export interface CrossValidationResult {
  reviews: ReviewResult[];
  overallPass: boolean;
  conflicts: string[];
  message?: string;
}

export class CrossValidator {
  constructor(
    private registry: ProviderRegistry,
    private chatAdapter?: ChatAdapter,
  ) {}

  private async chatWith(provider: AIProvider, request: ChatRequest): Promise<ChatResponse> {
    if (this.chatAdapter) return this.chatAdapter.chat(provider, request);
    return provider.chat(request);
  }

  private canValidate(providerId: string): boolean {
    if (this.chatAdapter) return true;
    return this.isAgentTier(providerId);
  }

  async validate(
    config: CrossValidationConfig,
  ): Promise<CrossValidationResult> {
    const { items, criteria } = config;
    const validators = this.resolveValidators(config);
    const reviews: ReviewResult[] = [];

    for (const item of items) {
      for (const validator of validators) {
        // Don't let a provider review its own work
        if (validator.id === item.providerId) continue;

        const review = await this.reviewItem(item, validator, criteria);
        reviews.push(review);
      }
    }

    const conflicts = this.detectConflicts(reviews);
    const overallPass =
      reviews.length > 0 && reviews.every((r) => r.passed);

    const message = reviews.length === 0
      ? (this.chatAdapter
        ? "No validators available for cross-validation."
        : "No agent-tier validators available for cross-validation.")
      : undefined;
    return { reviews, overallPass, conflicts, message };
  }

  private resolveValidators(config: CrossValidationConfig): AIProvider[] {
    if (config.validators) {
      return config.validators.filter((v) => this.canValidate(v.id));
    }

    // Use other item providers as cross-validators
    const seen = new Set<string>();
    const validators: AIProvider[] = [];
    for (const item of config.items) {
      if (seen.has(item.providerId)) continue;
      seen.add(item.providerId);
      if (this.canValidate(item.providerId)) {
        validators.push(this.registry.get(item.providerId));
      }
    }
    return validators;
  }

  private isAgentTier(providerId: string): boolean {
    const cap = this.registry.getCapability(providerId);
    return cap.tier === "agent";
  }

  private async reviewItem(
    item: CrossValidationItem,
    validator: AIProvider,
    criteria?: string,
  ): Promise<ReviewResult> {
    const criteriaText = criteria
      ? `\nAdditional criteria: ${criteria}`
      : "";

    const prompt = [
      `You are a cross-validator reviewing work from provider "${item.providerId}".`,
      `Task: ${item.task}`,
      `Content to review:\n${item.content}`,
      criteriaText,
      "",
      "Respond with JSON only: { \"passed\": boolean, \"feedback\": \"string\", \"suggestedFixes\": \"string or omit\" }",
    ].join("\n");

    const response = await this.chatWith(validator, { prompt });

    return this.parseReview(item.providerId, validator.id, response.text);
  }

  private parseReview(
    targetProvider: string,
    reviewerProvider: string,
    text: string,
  ): ReviewResult {
    try {
      const parsed = extractJsonFromText(text) as Record<string, unknown> | null;
      if (!parsed || typeof parsed !== "object") throw new Error("No JSON found");
      return {
        targetProvider,
        reviewerProvider,
        passed: Boolean(parsed.passed),
        feedback: String(parsed.feedback ?? ""),
        suggestedFixes: parsed.suggestedFixes
          ? String(parsed.suggestedFixes)
          : undefined,
      };
    } catch {
      // Fallback: treat as failed review with raw text as feedback
      return {
        targetProvider,
        reviewerProvider,
        passed: false,
        feedback: text,
      };
    }
  }

  private detectConflicts(reviews: ReviewResult[]): string[] {
    const conflicts: string[] = [];
    const byTarget = new Map<string, ReviewResult[]>();

    for (const review of reviews) {
      const key = review.targetProvider;
      if (!byTarget.has(key)) byTarget.set(key, []);
      byTarget.get(key)!.push(review);
    }

    for (const [target, targetReviews] of byTarget) {
      if (targetReviews.length < 2) continue;
      const passed = targetReviews.filter((r) => r.passed);
      const failed = targetReviews.filter((r) => !r.passed);
      if (passed.length > 0 && failed.length > 0) {
        const passedIds = passed.map((r) => r.reviewerProvider).join(", ");
        const failedIds = failed.map((r) => r.reviewerProvider).join(", ");
        conflicts.push(
          `Conflict on "${target}": passed by [${passedIds}], failed by [${failedIds}]`,
        );
      }
    }

    return conflicts;
  }
}
