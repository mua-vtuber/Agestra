// @agestra/agents — barrel export
export {
  DebateEngine,
  type DebateConfig,
  type DebateCreateConfig,
  type DebateResult,
  type DebateResponse,
  type DebateState,
  type DebateTurn,
  type EnhancedDebateConfig,
  type QualityCriteria,
  type ValidationResult,
} from "./debate.js";
export { SessionManager, type SessionType, type Session } from "./session-manager.js";
export { TaskDispatcher, type TaskAssignment, type DispatchConfig, type DispatchResult } from "./dispatcher.js";
export {
  CrossValidator,
  type CrossValidationItem,
  type CrossValidationConfig,
  type ReviewResult,
  type CrossValidationResult,
} from "./cross-validator.js";
export { extractJSON, extractJsonFromText } from "./json-parser.js";
export { AgentLoop, type AgentLoopConfig, type AgentLoopResult, type AgentLoopFactory, type ToolCallRecord } from "./agent-loop.js";
export { createDefaultTools, createReadOnlyTools, toOllamaToolDefs, type AgentTool, type OllamaToolDefinition } from "./agent-tools.js";
export { AgentLoopChatAdapter, type ChatAdapter, type AgentLoopChatAdapterConfig } from "./chat-adapter.js";
