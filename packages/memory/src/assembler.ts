/**
 * Token-budgeted context assembly for prompt construction.
 *
 * Allocates a total token budget across multiple context components
 * (system prompt, memories, recent history, response reserve) and
 * assembles them into a structured prompt context.
 *
 * Ported from bara_system/backend/app/services/memory/context_assembler.py
 */

import type {
  AssembledContext,
  ContextBudgetRatios,
  MemoryConfig,
  RetrievalResult,
  RetrievalPipelineData,
} from './types.js';
import { DEFAULT_BUDGET_RATIOS, DEFAULT_MEMORY_CONFIG } from './types.js';
import { estimateTokens, truncateToBudget } from './token-counter.js';
import type { PipelineStage } from './pipeline.js';

/** Component names matching the budget ratio keys. */
type BudgetComponent = keyof ContextBudgetRatios;

/** Internal per-component budget map. */
type BudgetMap = Record<BudgetComponent, number>;

/** Parameters for the assemble method. */
export interface AssembleParams {
  /** Retrieved memory results (scored and sorted). */
  memories?: RetrievalResult[];
  /** System prompt text. */
  systemPrompt?: string;
  /** Recent conversation history (pre-formatted). */
  recentHistory?: string;
  /** The user's current message. */
  userMessage?: string;
  /**
   * Dynamic total budget override (e.g., model-specific context window).
   * When provided, overrides config.contextTotalBudget.
   * Still subject to tokenSafetyMargin.
   */
  totalBudgetOverride?: number;
}

/**
 * Assembles prompt context within a token budget.
 *
 * Allocates budget proportionally across components, with unused
 * budget from empty components redistributed to others.
 */
export class ContextAssembler {
  private readonly config: MemoryConfig;

  constructor(config: MemoryConfig) {
    this.config = config;
  }

  /**
   * Assemble context components within token budget.
   *
   * @param params - Components to assemble.
   * @returns AssembledContext with formatted memoryContext and tokensUsed.
   */
  assemble(params: AssembleParams): AssembledContext {
    const {
      memories,
      systemPrompt = '',
      recentHistory = '',
      userMessage = '',
      totalBudgetOverride,
    } = params;

    // Apply safety margin to prevent token overflows from estimation errors
    const safetyMargin = this.config.tokenSafetyMargin ?? 0.9;
    const rawBudget = totalBudgetOverride ?? this.config.contextTotalBudget;
    const totalBudget = Math.floor(rawBudget * safetyMargin);
    const ratios = this.config.budgetRatios ?? DEFAULT_BUDGET_RATIOS;

    const budgets = ContextAssembler.calculateBudgets(totalBudget, ratios, {
      systemPrompt: systemPrompt.length > 0,
      memories: Array.isArray(memories) && memories.length > 0,
      recentHistory: recentHistory.length > 0,
      responseReserve: true,
    });

    // Format system prompt
    const systemText = systemPrompt
      ? truncateToBudget(systemPrompt, budgets.systemPrompt)
      : '';

    // Format memories
    const memoryText = memories && memories.length > 0
      ? ContextAssembler.formatMemories(memories, budgets.memories, {
          header: this.config.memoryContextHeader,
          importanceThreshold: this.config.importanceHighThreshold,
          importanceMarker: this.config.importanceMarkerText,
        })
      : '';

    // Format recent history
    const historyText = recentHistory
      ? truncateToBudget(recentHistory, budgets.recentHistory)
      : '';

    // Build the final context string
    const parts: string[] = [];
    if (systemText) parts.push(systemText);
    if (memoryText) parts.push(memoryText);
    if (historyText) parts.push(historyText);
    if (userMessage) parts.push(userMessage);

    const memoryContext = parts.join('\n\n');
    const tokensUsed = estimateTokens(memoryContext);

    return { memoryContext, tokensUsed };
  }

  /**
   * Calculate per-component token budgets with redistribution.
   *
   * Empty components donate their budget proportionally to active ones.
   */
  static calculateBudgets(
    totalBudget: number,
    ratios: ContextBudgetRatios,
    present: Record<BudgetComponent, boolean>,
  ): BudgetMap {
    const active: Partial<Record<BudgetComponent, number>> = {};
    let inactiveBudget = 0;

    const components: BudgetComponent[] = [
      'systemPrompt',
      'memories',
      'recentHistory',
      'responseReserve',
    ];

    for (const name of components) {
      if (present[name]) {
        active[name] = ratios[name];
      } else {
        inactiveBudget += ratios[name];
      }
    }

    // Redistribute inactive budget proportionally
    if (inactiveBudget > 0) {
      const activeTotal = Object.values(active).reduce((sum, v) => sum + v, 0);
      if (activeTotal > 0) {
        for (const name of Object.keys(active) as BudgetComponent[]) {
          const currentRatio = active[name] ?? 0;
          active[name] = currentRatio + inactiveBudget * (currentRatio / activeTotal);
        }
      }
    }

    // Convert ratios to token counts
    const budgets: BudgetMap = {
      systemPrompt: 0,
      memories: 0,
      recentHistory: 0,
      responseReserve: 0,
    };

    for (const name of components) {
      const ratio = active[name] ?? 0;
      budgets[name] = Math.floor(totalBudget * ratio);
    }

    return budgets;
  }

  /**
   * Format memories into context text, fitting within token budget.
   *
   * Iterates through sorted memories (highest score first), adding
   * each one until the budget is exhausted.
   */
  static formatMemories(
    memories: RetrievalResult[],
    budget: number,
    options?: {
      header?: string;
      importanceThreshold?: number;
      importanceMarker?: string;
    },
  ): string {
    if (!memories || memories.length === 0) {
      return '';
    }

    const header = options?.header ?? '[관련 기억]';
    const importanceThreshold = options?.importanceThreshold ?? 0.8;
    const importanceMarker = options?.importanceMarker ?? ' [중요]';
    const lines: string[] = [header];
    let usedTokens = estimateTokens(header);

    for (const result of memories) {
      const node = result.node;
      let line = `- ${node.content}`;

      // Add importance marker for high-value memories
      if (node.importance >= importanceThreshold) {
        line += importanceMarker;
      }

      const lineTokens = estimateTokens(line);
      if (usedTokens + lineTokens > budget) {
        break;
      }

      lines.push(line);
      usedTokens += lineTokens;
    }

    if (lines.length <= 1) {
      return '';
    }

    return lines.join('\n');
  }

  /**
   * Compute effective total budget for a given model context window.
   *
   * Applies the memories ratio from config to determine how many tokens
   * are available for memory content within the model's total context.
   *
   * @param modelContextWindow - The model's total context window in tokens.
   * @returns Token budget for the memory component.
   */
  static computeMemoryBudget(
    modelContextWindow: number,
    config?: Partial<MemoryConfig>,
  ): number {
    const c = { ...DEFAULT_MEMORY_CONFIG, ...config };
    const ratios = c.budgetRatios ?? DEFAULT_BUDGET_RATIOS;
    const safetyMargin = c.tokenSafetyMargin ?? 0.9;
    return Math.floor(modelContextWindow * ratios.memories * safetyMargin);
  }
}

// ── Pipeline Stage Adapter ──────────────────────────────────────────

/** Output of the ContextAssembler pipeline stage. */
export interface ContextAssemblerOutput {
  /** The assembled memory context string. */
  memoryContext: string;
  /** Token count of the assembled context. */
  tokensUsed: number;
  /** Original query (passed through). */
  query: string;
}

/**
 * Pipeline stage adapter for ContextAssembler.
 *
 * Takes RetrievalPipelineData (with results from Reranker) and
 * produces assembled context. Can be configured with static context
 * (system prompt, recent history) at construction time.
 */
export class ContextAssemblerStage
  implements PipelineStage<RetrievalPipelineData, ContextAssemblerOutput>
{
  readonly name = 'ContextAssembler';
  private readonly assembler: ContextAssembler;
  private systemPrompt: string;
  private recentHistory: string;

  constructor(
    config?: Partial<MemoryConfig>,
    options?: { systemPrompt?: string; recentHistory?: string },
  ) {
    this.assembler = new ContextAssembler({ ...DEFAULT_MEMORY_CONFIG, ...config });
    this.systemPrompt = options?.systemPrompt ?? '';
    this.recentHistory = options?.recentHistory ?? '';
  }

  /** Update static context (called before each pipeline execution). */
  setContext(systemPrompt: string, recentHistory: string): void {
    this.systemPrompt = systemPrompt;
    this.recentHistory = recentHistory;
  }

  async execute(input: RetrievalPipelineData): Promise<ContextAssemblerOutput> {
    const assembled = this.assembler.assemble({
      memories: input.results,
      systemPrompt: this.systemPrompt,
      recentHistory: this.recentHistory,
    });

    return {
      memoryContext: assembled.memoryContext,
      tokensUsed: assembled.tokensUsed,
      query: input.query,
    };
  }
}
