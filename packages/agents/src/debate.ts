import { randomUUID } from "crypto";
import type { AIProvider, ChatRequest, ChatResponse } from "@agestra/core";
import type { ChatAdapter } from "./chat-adapter.js";
import { extractJsonFromText } from "./json-parser.js";

export interface DebateConfig {
  topic: string;
  providers: AIProvider[];
  maxRounds: number;
  deadEndContext?: string;
}

export interface DebateResponse {
  provider: string;
  text: string;
}

export interface DebateResult {
  topic: string;
  rounds: DebateResponse[][];
  transcript: string;
  consensusDocument: string;
}

export interface QualityCriteria {
  goalAchievement: boolean;
  completeness: boolean;
  accuracy: boolean;
  consistency: boolean;
}

export interface ValidationResult {
  passed: boolean;
  criteria: QualityCriteria;
  feedback: string;
}

export interface EnhancedDebateConfig extends DebateConfig {
  goal: string;
  qualityCriteria?: QualityCriteria;
  validator?: AIProvider;
  minRounds?: number;
}

// ── Turn-based debate types ──────────────────────────────────

export interface DebateTurn {
  turnNumber: number;
  speaker: string;       // provider ID or "claude"
  content: string;
  timestamp: string;
}

export interface DebateState {
  id: string;
  topic: string;
  goal?: string;
  providerIds: string[];
  turns: DebateTurn[];
  status: "active" | "concluded";
  documentId?: string;   // linked workspace document
  createdAt: string;
}

export interface DebateCreateConfig {
  topic: string;
  providerIds: string[];
  goal?: string;
  documentId?: string;
}

const DEBATE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

export class DebateEngine {
  private debates = new Map<string, DebateState>();

  constructor(private chatAdapter?: ChatAdapter) {}

  private async chatWith(provider: AIProvider, request: ChatRequest): Promise<ChatResponse> {
    if (this.chatAdapter) return this.chatAdapter.chat(provider, request);
    return provider.chat(request);
  }

  // ── Turn-based stateful methods ──────────────────────────────

  create(config: DebateCreateConfig): DebateState {
    this.purgeStaleDebates();
    const id = randomUUID();
    const now = new Date().toISOString();
    const state: DebateState = {
      id,
      topic: config.topic,
      goal: config.goal,
      providerIds: config.providerIds,
      turns: [],
      status: "active",
      documentId: config.documentId,
      createdAt: now,
    };
    this.debates.set(id, state);
    return state;
  }

  addTurn(debateId: string, speaker: string, content: string): DebateState {
    const state = this.getState(debateId);
    if (!state) throw new Error(`Debate not found: ${debateId}`);
    if (state.status === "concluded") throw new Error(`Debate already concluded: ${debateId}`);

    const turn: DebateTurn = {
      turnNumber: state.turns.length + 1,
      speaker,
      content,
      timestamp: new Date().toISOString(),
    };
    state.turns.push(turn);
    return state;
  }

  buildPromptForProvider(debateId: string, providerId: string): string {
    const state = this.getState(debateId);
    if (!state) throw new Error(`Debate not found: ${debateId}`);

    let prompt = `Topic: ${state.topic}\n`;
    if (state.goal) {
      prompt += `Goal: ${state.goal}\n`;
    }

    if (state.turns.length > 0) {
      prompt += `\n=== Conversation History ===\n\n`;
      for (const turn of state.turns) {
        prompt += `[Turn ${turn.turnNumber}] ${turn.speaker}:\n${turn.content}\n\n`;
      }
      prompt += `===\n\n`;
    }

    prompt += `You are ${providerId}. Please share your perspective considering the above discussion.`;
    return prompt;
  }

  conclude(debateId: string): DebateState {
    const state = this.getState(debateId);
    if (!state) throw new Error(`Debate not found: ${debateId}`);
    state.status = "concluded";
    return state;
  }

  getState(debateId: string): DebateState | undefined {
    return this.debates.get(debateId);
  }

  delete(debateId: string): boolean {
    return this.debates.delete(debateId);
  }

  buildTurnTranscript(debateId: string): string {
    const state = this.getState(debateId);
    if (!state) throw new Error(`Debate not found: ${debateId}`);

    let doc = `# Debate: ${state.topic}\n\n`;
    if (state.goal) {
      doc += `**Goal:** ${state.goal}\n\n`;
    }
    doc += `**Participants:** ${state.providerIds.join(", ")}\n\n`;
    doc += `---\n\n`;
    for (const turn of state.turns) {
      doc += `### [Turn ${turn.turnNumber}] ${turn.speaker}\n\n${turn.content}\n\n`;
    }
    return doc;
  }

  private purgeStaleDebates(): void {
    const now = Date.now();
    for (const [id, state] of this.debates) {
      if (state.status !== "active") continue;
      const createdMs = new Date(state.createdAt).getTime();
      if (now - createdMs > DEBATE_TTL_MS) {
        this.debates.delete(id);
      }
    }
  }

  // ── Legacy round-based method (backward compat) ──────────────
  private isEnhanced(config: DebateConfig | EnhancedDebateConfig): config is EnhancedDebateConfig {
    return "goal" in config && "validator" in config && !!(config as EnhancedDebateConfig).validator;
  }

  async run(config: DebateConfig | EnhancedDebateConfig): Promise<DebateResult> {
    const { topic, providers, maxRounds } = config;
    const rounds: DebateResponse[][] = [];
    let history = "";
    let validationFeedback = "";

    const enhanced = this.isEnhanced(config);
    const minRounds = enhanced ? (config.minRounds ?? 2) : maxRounds;

    for (let round = 0; round < maxRounds; round++) {
      const roundResponses: DebateResponse[] = [];

      for (const provider of providers) {
        let prompt: string;
        if (round === 0) {
          const deadEndPrefix = config.deadEndContext
            ? `\u26a0\ufe0f Previously failed approaches:\n${config.deadEndContext}\nAvoid these and suggest alternatives.\n\n`
            : "";
          prompt = `${deadEndPrefix}Topic for debate: ${topic}\n\nPlease share your perspective.`;
        } else {
          prompt = `Topic: ${topic}\n\nPrevious discussion:\n${history}\n\nPlease respond considering the above discussion.`;
        }

        if (validationFeedback) {
          prompt += `\n\nValidator feedback from previous round:\n${validationFeedback}`;
        }

        const response = await this.chatWith(provider, { prompt });
        roundResponses.push({ provider: provider.id, text: response.text });
      }

      rounds.push(roundResponses);

      // Build history for next round
      history += `\n### Round ${round + 1}\n`;
      for (const r of roundResponses) {
        history += `**${r.provider}:** ${r.text}\n\n`;
      }

      // Enhanced mode: validate after minRounds
      if (enhanced && round + 1 >= minRounds) {
        const validation = await this.validate(config, history);
        if (validation.passed) {
          break;
        }
        validationFeedback = validation.feedback;
      }
    }

    const transcript = this.buildTranscript(topic, rounds);
    const consensusDocument = this.buildConsensus(topic, rounds);

    return { topic, rounds, transcript, consensusDocument };
  }

  private async validate(
    config: EnhancedDebateConfig,
    history: string,
  ): Promise<ValidationResult> {
    const prompt = `Evaluate this debate round against the goal: "${config.goal}"

Current discussion:
${history}

Respond in JSON:
{
  "goalAchievement": true/false,
  "completeness": true/false,
  "accuracy": true/false,
  "consistency": true/false,
  "feedback": "..."
}`;

    const response = await this.chatWith(config.validator!, { prompt });
    return this.parseValidation(response.text);
  }

  private parseValidation(text: string): ValidationResult {
    try {
      // Try to extract JSON from the response
      const parsed = extractJsonFromText(text) as Record<string, unknown> | null;
      if (parsed) {
        const criteria: QualityCriteria = {
          goalAchievement: !!parsed.goalAchievement,
          completeness: !!parsed.completeness,
          accuracy: !!parsed.accuracy,
          consistency: !!parsed.consistency,
        };
        const passed = criteria.goalAchievement && criteria.completeness
          && criteria.accuracy && criteria.consistency;
        return { passed, criteria, feedback: String(parsed.feedback ?? "") };
      }
    } catch {
      // fallback below
    }

    // Fallback: treat as not passing
    return {
      passed: false,
      criteria: {
        goalAchievement: false,
        completeness: false,
        accuracy: false,
        consistency: false,
      },
      feedback: text,
    };
  }

  private buildTranscript(
    topic: string,
    rounds: DebateResponse[][],
  ): string {
    let doc = `# Debate: ${topic}\n\n`;
    rounds.forEach((round, i) => {
      doc += `## Round ${i + 1}\n\n`;
      round.forEach((r) => {
        doc += `### ${r.provider}\n\n${r.text}\n\n`;
      });
    });
    return doc;
  }

  private buildConsensus(
    topic: string,
    rounds: DebateResponse[][],
  ): string {
    let doc = `# Consensus: ${topic}\n\n`;
    doc += `## Participants\n\n`;
    const providers = [...new Set(rounds.flat().map((r) => r.provider))];
    providers.forEach((p) => {
      doc += `- ${p}\n`;
    });
    doc += `\n## Discussion Summary\n\n`;
    // Include final round responses as the consensus basis
    const lastRound = rounds[rounds.length - 1];
    lastRound.forEach((r) => {
      doc += `**${r.provider}:** ${r.text}\n\n`;
    });
    return doc;
  }
}
