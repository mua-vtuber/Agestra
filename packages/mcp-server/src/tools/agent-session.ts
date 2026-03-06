import { z } from "zod";
import { execSync } from "child_process";
import type { ProviderRegistry, JobManager } from "@agestra/core";
import type { TraceWriter } from "@agestra/core";
import type { SessionManager } from "@agestra/agents";
import type { DocumentManager } from "@agestra/workspace";
import type { MemoryFacade } from "@agestra/memory";
import { DebateEngine, TaskChainEngine, TaskDispatcher, CrossValidator, AgentLoop, AgentLoopChatAdapter, AutoQA, FileChangeTracker, createDefaultTools, createReadOnlyTools, getOllamaConnectionInfo, extractJsonFromText } from "@agestra/agents";
import type { DebateConfig, EnhancedDebateConfig, AgentLoopFactory, ChatAdapter } from "@agestra/agents";
import { buildCapabilityProfile } from "@agestra/core";

// ── Zod schemas ──────────────────────────────────────────────

const AgentDebateStartSchema = z.object({
  topic: z.string().describe("Topic for the debate"),
  providers: z.array(z.string()).min(1).describe("Provider IDs to participate"),
  max_rounds: z.number().int().positive().optional().default(3).describe("Maximum debate rounds"),
  goal: z.string().optional().describe("Quality goal for enhanced debate mode (enables quality validation loop)"),
  validator: z.string().optional().describe("Provider ID for quality validation (agent-tier recommended)"),
  min_rounds: z.number().int().positive().optional().default(2).describe("Minimum rounds before validation (default: 2)"),
});

const AgentDispatchSchema = z.object({
  assignments: z.array(z.object({
    id: z.string().optional().describe("Assignment ID (auto-generated if omitted)"),
    provider: z.string().describe("Provider ID"),
    task: z.string().describe("Task description"),
    files: z.array(z.string()).optional().describe("Relevant file paths"),
    depends_on: z.array(z.string()).optional().describe("IDs of assignments this depends on"),
  })).min(1).describe("List of task assignments"),
  merge_strategy: z.enum(["concatenate", "summarize", "debate"]).optional().default("concatenate").describe("How to merge results"),
  timeout_ms: z.number().int().positive().optional().describe("Overall timeout in ms (default: 600000)"),
  auto_qa: z.boolean().optional().default(false).describe("Run AutoQA after all tasks complete"),
  design_doc: z.string().optional().describe("Design document path for QA verification"),
});

const AgentCrossValidateSchema = z.object({
  items: z.array(z.object({
    provider: z.string().describe("Provider that produced the content"),
    content: z.string().describe("Content to validate"),
    task: z.string().describe("Original task description"),
  })).min(1).describe("Items to cross-validate"),
  validators: z.array(z.string()).optional().describe("Provider IDs to use as validators (agent-tier only)"),
  criteria: z.string().optional().describe("Custom validation criteria"),
});

const AgentDebateStatusSchema = z.object({
  session_id: z.string().describe("Session ID to check"),
});

const AgentAssignTaskSchema = z.object({
  provider: z.string().describe("Provider ID to assign the task to"),
  task: z.string().describe("Task description"),
  files: z.array(z.string()).optional().describe("File paths relevant to the task"),
  isolate: z.boolean().optional().describe("Run task in an isolated git worktree"),
});

const AgentTaskStatusSchema = z.object({
  task_id: z.string().describe("Task ID to check"),
});

const AgentDebateCreateSchema = z.object({
  topic: z.string().describe("Topic for the debate"),
  providers: z.array(z.string()).min(1).describe("Provider IDs to participate"),
  goal: z.string().optional().describe("Quality goal for the debate"),
  save_document: z.boolean().optional().default(true).describe("Save debate as a workspace document (default: true)"),
});

const AgentDebateTurnSchema = z.object({
  debate_id: z.string().describe("Debate session ID"),
  provider: z.string().describe("Provider ID to take this turn. Use \"claude\" to record Claude's own opinion as an independent turn (requires claude_comment)."),
  claude_comment: z.string().optional().describe("Claude's opinion. When provider is \"claude\", this becomes the turn content. Otherwise, injected before the provider responds."),
});

const AgentDebateConcludeSchema = z.object({
  debate_id: z.string().describe("Debate session ID to conclude"),
  summary: z.string().optional().describe("Claude's final summary of the debate"),
  quality_scores: z.array(z.object({
    provider: z.string(),
    score: z.number().min(0).max(1),
    feedback: z.string(),
  })).optional().describe("Quality assessment of each provider's contribution"),
});

const AgentDebateReviewSchema = z.object({
  document: z.string().describe("Document content to review"),
  providers: z.array(z.string()).min(1).describe("Provider IDs to review the document"),
  review_prompt: z.string().optional().describe("Custom review instructions (default: agree/disagree with feedback)"),
  debate_id: z.string().optional().describe("Link reviews to an existing debate session's workspace document"),
});

const AgentChangesReviewSchema = z.object({
  task_id: z.string().describe("Task ID to review changes for"),
});

const AgentChangesAcceptSchema = z.object({
  task_id: z.string().describe("Task ID whose changes to accept"),
  message: z.string().optional().describe("Commit message for the merge"),
});

const AgentChangesRejectSchema = z.object({
  task_id: z.string().describe("Task ID whose changes to reject"),
  reason: z.string().optional().describe("Reason for rejection"),
});

const AgentTaskChainCreateSchema = z.object({
  steps: z.array(z.object({
    id: z.string().describe("Unique step ID"),
    description: z.string().describe("Step description"),
    prompt: z.string().describe("Prompt for the provider"),
    provider: z.string().describe("Provider ID to execute this step"),
    dependsOn: z.array(z.string()).optional().describe("Step IDs this depends on"),
    checkpoint: z.boolean().optional().describe("Pause after this step for review"),
    validation: z.string().optional().describe("Validation prompt to verify output"),
  })).min(1).describe("Task chain steps"),
});

const AgentTaskChainStepSchema = z.object({
  chain_id: z.string().describe("Chain ID"),
  step_id: z.string().optional().describe("Specific step to execute (default: next)"),
  override_prompt: z.string().optional().describe("Override the step's prompt"),
});

const AgentTaskChainStepAsyncSchema = z.object({
  chain_id: z.string().describe("Chain ID"),
  step_id: z.string().optional().describe("Specific step to start (default: next)"),
  override_prompt: z.string().optional().describe("Override the step's prompt"),
});

const AgentTaskChainAwaitSchema = z.object({
  chain_id: z.string().describe("Chain ID"),
  step_id: z.string().describe("Step ID to await"),
});

const AgentTaskChainStatusSchema = z.object({
  chain_id: z.string().describe("Chain ID to check"),
});

const SessionListSchema = z.object({
  type: z.enum(["all", "debate", "review", "task"]).optional()
    .default("all")
    .describe("Filter by session type (default: all)"),
  status: z.enum(["all", "pending", "in_progress", "completed", "failed"]).optional()
    .default("all")
    .describe("Filter by session status (default: all)"),
});

// ── Types ────────────────────────────────────────────────────

export interface AgentToolDeps {
  registry: ProviderRegistry;
  sessionManager: SessionManager;
  memoryFacade: MemoryFacade;
  jobManager: JobManager;
  documentManager: DocumentManager;
  traceWriter?: TraceWriter;
}

// Lazy-initialized adapter instances (deferred so process.cwd() is captured at first use)
let _readOnlyAdapter: AgentLoopChatAdapter | undefined;
let _fullAdapter: AgentLoopChatAdapter | undefined;

function getReadOnlyAdapter(): AgentLoopChatAdapter {
  return _readOnlyAdapter ??= new AgentLoopChatAdapter({
    tools: createReadOnlyTools(),
    baseDir: process.cwd(),
  });
}

function getFullAdapter(): AgentLoopChatAdapter {
  return _fullAdapter ??= new AgentLoopChatAdapter({
    tools: createDefaultTools(),
    baseDir: process.cwd(),
  });
}

// Shared debate engine instance for turn-based debates (lazy)
let _debateEngine: DebateEngine | undefined;
function getDebateEngine(): DebateEngine {
  return _debateEngine ??= new DebateEngine(getReadOnlyAdapter());
}

let _fileChangeTracker: FileChangeTracker | undefined;
function getFileChangeTracker(): FileChangeTracker {
  return _fileChangeTracker ??= new FileChangeTracker(process.cwd());
}

let _taskChainEngine: TaskChainEngine | undefined;
function getTaskChainEngine(registry: ProviderRegistry): TaskChainEngine {
  return _taskChainEngine ??= new TaskChainEngine(getFullAdapter(), registry);
}

/**
 * Create an AgentLoopFactory for the dispatcher.
 */
function createAgentLoopFactory(deps: AgentToolDeps): AgentLoopFactory {
  return {
    create(providerId: string) {
      const provider = deps.registry.get(providerId);
      const profile = buildCapabilityProfile(providerId, provider.getCapabilities());
      if (profile.tier !== "tool") return null;

      const connInfo = getOllamaConnectionInfo(provider);
      if (!connInfo) return null;

      return new AgentLoop({
        providerHost: connInfo.host,
        model: connInfo.model,
        baseDir: process.cwd(),
      });
    },
  };
}

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * Capture a git diff snapshot for tracking file changes made by external AIs.
 * Returns the short-stat summary or empty string if not a git repo.
 */
function captureGitSnapshot(): string {
  try {
    return execSync("git diff --stat HEAD 2>/dev/null", { encoding: "utf-8", timeout: 5_000 }).trim();
  } catch {
    return "";
  }
}

/**
 * Compute file changes between two git snapshots.
 */
function computeFileChanges(before: string, after: string): string | undefined {
  if (before === after) return undefined;
  if (!after) return undefined;
  return after;
}

// ── Tool definitions ─────────────────────────────────────────

export function getTools() {
  return [
    {
      name: "agent_debate_start",
      description:
        "Start a multi-provider debate on a topic. Optionally enable enhanced mode with goal-based quality validation.",
      inputSchema: {
        type: "object" as const,
        properties: {
          topic: { type: "string", description: "Topic for the debate" },
          providers: {
            type: "array",
            items: { type: "string" },
            description: "Provider IDs to participate",
          },
          max_rounds: {
            type: "number",
            description: "Maximum debate rounds (default: 3)",
          },
          goal: { type: "string", description: "Quality goal for enhanced debate mode" },
          validator: { type: "string", description: "Provider ID for quality validation" },
          min_rounds: { type: "number", description: "Minimum rounds before validation (default: 2)" },
        },
        required: ["topic", "providers"],
      },
    },
    {
      name: "agent_debate_status",
      description:
        "Check the status and result of a debate session.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: { type: "string", description: "Session ID to check" },
        },
        required: ["session_id"],
      },
    },
    {
      name: "agent_assign_task",
      description:
        "Assign a task to a specific AI provider. Creates a session and executes the task.",
      inputSchema: {
        type: "object" as const,
        properties: {
          provider: { type: "string", description: "Provider ID to assign the task to" },
          task: { type: "string", description: "Task description" },
          files: {
            type: "array",
            items: { type: "string" },
            description: "File paths relevant to the task",
          },
          isolate: {
            type: "boolean",
            description: "Run in isolated git worktree",
          },
        },
        required: ["provider", "task"],
      },
    },
    {
      name: "agent_task_status",
      description:
        "Check the status and result of an assigned task.",
      inputSchema: {
        type: "object" as const,
        properties: {
          task_id: { type: "string", description: "Task ID to check" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "agent_dispatch",
      description:
        "Dispatch tasks to multiple providers in parallel. Supports dependency ordering and result merging.",
      inputSchema: {
        type: "object" as const,
        properties: {
          assignments: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Assignment ID (auto-generated if omitted)" },
                provider: { type: "string", description: "Provider ID" },
                task: { type: "string", description: "Task description" },
                files: { type: "array", items: { type: "string" }, description: "Relevant file paths" },
                depends_on: { type: "array", items: { type: "string" }, description: "Dependency assignment IDs" },
              },
              required: ["provider", "task"],
            },
            description: "List of task assignments",
          },
          merge_strategy: {
            type: "string",
            enum: ["concatenate", "summarize", "debate"],
            description: "How to merge results (default: concatenate)",
          },
          timeout_ms: {
            type: "number",
            description: "Overall timeout in ms (default: 600000)",
          },
          auto_qa: {
            type: "boolean",
            description: "Run AutoQA after all tasks complete (default: false)",
          },
          design_doc: {
            type: "string",
            description: "Design document path for QA verification",
          },
        },
        required: ["assignments"],
      },
    },
    {
      name: "agent_cross_validate",
      description:
        "Cross-validate work outputs. Each item is reviewed by agent-tier providers. Tool-tier providers cannot be validators.",
      inputSchema: {
        type: "object" as const,
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                provider: { type: "string", description: "Provider that produced the content" },
                content: { type: "string", description: "Content to validate" },
                task: { type: "string", description: "Original task description" },
              },
              required: ["provider", "content", "task"],
            },
            description: "Items to cross-validate",
          },
          validators: {
            type: "array",
            items: { type: "string" },
            description: "Provider IDs to use as validators (agent-tier only)",
          },
          criteria: { type: "string", description: "Custom validation criteria" },
        },
        required: ["items"],
      },
    },
    {
      name: "agent_debate_create",
      description:
        "Create a turn-based debate session. Returns a debate ID for use with agent_debate_turn and agent_debate_conclude.",
      inputSchema: {
        type: "object" as const,
        properties: {
          topic: { type: "string", description: "Topic for the debate" },
          providers: {
            type: "array",
            items: { type: "string" },
            description: "Provider IDs to participate",
          },
          goal: { type: "string", description: "Quality goal for the debate" },
          save_document: {
            type: "boolean",
            description: "Save debate as a workspace document (default: true)",
          },
        },
        required: ["topic", "providers"],
      },
    },
    {
      name: "agent_debate_turn",
      description:
        "Execute one provider's turn in a debate. Optionally inject Claude's comment before the provider responds. Returns the provider's response. " +
        "Use provider: \"claude\" with claude_comment to record Claude's own independent opinion as a debate turn.",
      inputSchema: {
        type: "object" as const,
        properties: {
          debate_id: { type: "string", description: "Debate session ID" },
          provider: { type: "string", description: "Provider ID to take this turn" },
          claude_comment: {
            type: "string",
            description: "Claude's opinion injected before this turn",
          },
        },
        required: ["debate_id", "provider"],
      },
    },
    {
      name: "agent_debate_conclude",
      description:
        "End a debate session and generate the final transcript. Optionally add Claude's summary and quality scores for each provider.",
      inputSchema: {
        type: "object" as const,
        properties: {
          debate_id: { type: "string", description: "Debate session ID to conclude" },
          summary: { type: "string", description: "Claude's final summary of the debate" },
          quality_scores: {
            type: "array",
            items: {
              type: "object",
              properties: {
                provider: { type: "string", description: "Provider ID" },
                score: { type: "number", description: "Quality score from 0 to 1" },
                feedback: { type: "string", description: "Quality feedback" },
              },
              required: ["provider", "score", "feedback"],
            },
            description: "Quality assessment of each provider's contribution",
          },
        },
        required: ["debate_id"],
      },
    },
    {
      name: "agent_debate_review",
      description:
        "Send a document to multiple providers for structured review. Each provider responds with agree/disagree and feedback. " +
        "Use iteratively: review → revise document based on feedback → review again until all agree.",
      inputSchema: {
        type: "object" as const,
        properties: {
          document: { type: "string", description: "Document content to review" },
          providers: {
            type: "array",
            items: { type: "string" },
            description: "Provider IDs to review the document",
          },
          review_prompt: {
            type: "string",
            description: "Custom review instructions (default: agree/disagree with feedback)",
          },
          debate_id: {
            type: "string",
            description: "Link reviews to an existing debate's workspace document",
          },
        },
        required: ["document", "providers"],
      },
    },
    {
      name: "agent_task_chain_create",
      description:
        "Create a multi-step task chain. Each step runs on a designated provider with context from previous steps. " +
        "Supports dependency ordering, checkpoints (pausing for review), and validation.",
      inputSchema: {
        type: "object" as const,
        properties: {
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Unique step ID" },
                description: { type: "string", description: "Step description" },
                prompt: { type: "string", description: "Prompt for the provider" },
                provider: { type: "string", description: "Provider ID" },
                dependsOn: { type: "array", items: { type: "string" }, description: "Dependency step IDs" },
                checkpoint: { type: "boolean", description: "Pause after this step" },
                validation: { type: "string", description: "Validation prompt" },
              },
              required: ["id", "description", "prompt", "provider"],
            },
            description: "Task chain steps",
          },
        },
        required: ["steps"],
      },
    },
    {
      name: "agent_task_chain_step",
      description:
        "Execute the next (or specified) step in a task chain. Returns the step result including output and validation. " +
        "If the step has checkpoint: true, the chain pauses after execution for team-lead review.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chain_id: { type: "string", description: "Chain ID" },
          step_id: { type: "string", description: "Specific step to execute (default: next)" },
          override_prompt: { type: "string", description: "Override the step's prompt" },
        },
        required: ["chain_id"],
      },
    },
    {
      name: "agent_task_chain_step_async",
      description:
        "Start a task chain step in the background without blocking. Returns immediately so you can do other work. " +
        "Use `agent_task_chain_await` to collect the result later, or `agent_task_chain_status` to check progress.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chain_id: { type: "string", description: "Chain ID" },
          step_id: { type: "string", description: "Specific step to start (default: next)" },
          override_prompt: { type: "string", description: "Override the step's prompt" },
        },
        required: ["chain_id"],
      },
    },
    {
      name: "agent_task_chain_await",
      description:
        "Wait for a background step to complete and return its result. " +
        "Use after `agent_task_chain_step_async` when you're ready to collect the output.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chain_id: { type: "string", description: "Chain ID" },
          step_id: { type: "string", description: "Step ID to await" },
        },
        required: ["chain_id", "step_id"],
      },
    },
    {
      name: "agent_task_chain_status",
      description:
        "Check the status of a task chain, including each step's completion status and output preview. " +
        "Also shows any steps currently running in the background.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chain_id: { type: "string", description: "Chain ID to check" },
        },
        required: ["chain_id"],
      },
    },
    {
      name: "agent_changes_review",
      description:
        "Review file changes made by an external AI in an isolated worktree. Shows diff stat and full diff.",
      inputSchema: {
        type: "object" as const,
        properties: {
          task_id: { type: "string", description: "Task ID to review" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "agent_changes_accept",
      description:
        "Accept and merge file changes from an isolated worktree back to the main branch.",
      inputSchema: {
        type: "object" as const,
        properties: {
          task_id: { type: "string", description: "Task ID whose changes to accept" },
          message: { type: "string", description: "Commit message" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "agent_changes_reject",
      description:
        "Reject file changes and clean up the isolated worktree.",
      inputSchema: {
        type: "object" as const,
        properties: {
          task_id: { type: "string", description: "Task ID whose changes to reject" },
          reason: { type: "string", description: "Reason for rejection" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "session_list",
      description:
        "List all agent sessions with optional filtering by type and status.",
      inputSchema: {
        type: "object" as const,
        properties: {
          type: {
            type: "string",
            enum: ["all", "debate", "review", "task"],
            description: "Filter by session type (default: all)",
          },
          status: {
            type: "string",
            enum: ["all", "pending", "in_progress", "completed", "failed"],
            description: "Filter by session status (default: all)",
          },
        },
        required: [],
      },
    },
  ];
}

// ── Handlers ─────────────────────────────────────────────────

async function handleDebateStart(
  args: unknown,
  deps: AgentToolDeps,
): Promise<McpToolResult> {
  const parsed = AgentDebateStartSchema.parse(args);

  // Validate all providers exist
  const providers = parsed.providers.map((id) => deps.registry.get(id));

  // Create session
  const session = deps.sessionManager.createSession("debate", {
    topic: parsed.topic,
    providers: parsed.providers,
    maxRounds: parsed.max_rounds,
  });

  // Mark in progress
  deps.sessionManager.updateSessionStatus(session.id, "in_progress");

  // Build debate config (enhanced if goal + validator provided)
  const debateConfig: DebateConfig | EnhancedDebateConfig = parsed.goal && parsed.validator
    ? {
        topic: parsed.topic,
        providers,
        maxRounds: parsed.max_rounds,
        goal: parsed.goal,
        validator: deps.registry.get(parsed.validator),
        minRounds: parsed.min_rounds,
      } as EnhancedDebateConfig
    : {
        topic: parsed.topic,
        providers,
        maxRounds: parsed.max_rounds,
      };

  // Fetch dead_end context from memory (await to avoid race condition)
  try {
    const deadEnds = await deps.memoryFacade.search(
      parsed.topic,
      { nodeType: "dead_end" as any, limit: 5 },
    );
    if (deadEnds.length > 0) {
      debateConfig.deadEndContext = deadEnds
        .map((d) => `- ${d.node.content}`)
        .join("\n");
    }
  } catch {
    // dead-end loading failure is non-critical — debate continues without it
  }

  // Run debate (non-blocking)
  const engine = new DebateEngine(getReadOnlyAdapter());
  engine.run(debateConfig).then((result) => {
    deps.sessionManager.completeSession(session.id, result.transcript);
    deps.memoryFacade.store({
      content: `Debate on "${parsed.topic}": ${result.consensusDocument}`,
      nodeType: "finding",
      topic: "context",
      importance: 0.7,
      source: "auto",
      providerId: parsed.providers.join(","),
    });
  }).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    deps.sessionManager.updateSessionStatus(session.id, "failed");
    deps.memoryFacade.store({
      content: `Debate on "${parsed.topic}" failed: ${message}`,
      nodeType: "dead_end",
      topic: "context",
      importance: 0.6,
      source: "auto",
      providerId: parsed.providers.join(","),
    });
  });

  return {
    content: [
      {
        type: "text",
        text: `**Debate started**\n**Session ID:** ${session.id}\n**Topic:** ${parsed.topic}\n**Participants:** ${parsed.providers.join(", ")}\n\nUse \`agent_debate_status\` to check progress.`,
      },
    ],
  };
}

async function handleDebateStatus(
  args: unknown,
  deps: AgentToolDeps,
): Promise<McpToolResult> {
  const parsed = AgentDebateStatusSchema.parse(args);
  const session = deps.sessionManager.getSession(parsed.session_id);

  if (!session) {
    return {
      content: [
        { type: "text", text: `Session not found: ${parsed.session_id}` },
      ],
      isError: true,
    };
  }

  let text = `**Session ID:** ${session.id}\n**Type:** ${session.type}\n**Status:** ${session.status}\n**Created:** ${session.createdAt}\n**Updated:** ${session.updatedAt}`;

  if (session.config) {
    const config = session.config;
    if (config.topic) text += `\n**Topic:** ${config.topic}`;
    if (config.providers) text += `\n**Providers:** ${(config.providers as string[]).join(", ")}`;
  }

  if (session.result) {
    text += `\n\n---\n\n${session.result}`;
  }

  return { content: [{ type: "text", text }] };
}

async function handleAssignTask(
  args: unknown,
  deps: AgentToolDeps,
): Promise<McpToolResult> {
  const parsed = AgentAssignTaskSchema.parse(args);

  // Validate provider exists
  const provider = deps.registry.get(parsed.provider);

  // Create session for the task
  const session = deps.sessionManager.createSession("task", {
    provider: parsed.provider,
    task: parsed.task,
    files: parsed.files || [],
  });

  deps.sessionManager.updateSessionStatus(session.id, "in_progress");

  // Build prompt
  const filesContext =
    parsed.files && parsed.files.length > 0
      ? `\n\nRelevant files:\n${parsed.files.map((f) => `- ${f}`).join("\n")}`
      : "";

  const prompt = `Task: ${parsed.task}${filesContext}\n\nPlease complete this task and provide your response.`;

  // Build reasoning metadata for trace
  const reasoning = deps.traceWriter ? {
    candidateProviders: deps.registry.getAvailable().map((p) => p.id),
    selectedProvider: parsed.provider,
    selectionReason: `Explicitly requested provider: ${parsed.provider}`,
    memoryHit: false,
  } : undefined;

  const startTime = performance.now();
  const snapshotBefore = captureGitSnapshot();

  // Create isolated worktree if requested
  let worktreePath: string | null = null;
  if (parsed.isolate) {
    const tracker = getFileChangeTracker();
    const wt = tracker.createWorktree(session.id);
    if (wt) {
      worktreePath = wt.path;
    }
  }

  try {
    const response = await getFullAdapter().chat(provider, { prompt });
    const latencyMs = Math.round(performance.now() - startTime);

    // Track file changes made by external AI
    const snapshotAfter = captureGitSnapshot();
    const fileChanges = computeFileChanges(snapshotBefore, snapshotAfter);

    if (deps.traceWriter) {
      deps.traceWriter.write({
        traceId: session.id,
        action: "chat",
        providerId: parsed.provider,
        task: parsed.task,
        request: { promptSummary: prompt.slice(0, 100), fileCount: parsed.files?.length ?? 0 },
        response: { success: true, charLength: response.text.length },
        latencyMs,
        reasoning,
      });
    }

    deps.sessionManager.completeSession(session.id, response.text);

    let resultText = `**Task completed**\n**Task ID:** ${session.id}\n**Provider:** ${parsed.provider}\n\n${response.text}`;
    if (fileChanges) {
      resultText += `\n\n---\n\n**File changes detected:**\n\`\`\`\n${fileChanges}\n\`\`\``;
    }

    if (worktreePath) {
      const tracker = getFileChangeTracker();
      const report = tracker.captureChanges(session.id, parsed.provider);
      resultText += `\n\n---\n**Worktree:** ${worktreePath}\n**Branch:** ${report.branch}\n**Changes:** ${report.changes.length} files\n\`\`\`\n${report.diffStat}\n\`\`\`\nUse \`agent_changes_review\` to see full diff, then \`agent_changes_accept\` or \`agent_changes_reject\`.`;
    }

    return {
      content: [{ type: "text", text: resultText }],
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - startTime);
    deps.sessionManager.updateSessionStatus(session.id, "failed");
    const message = err instanceof Error ? err.message : String(err);

    if (deps.traceWriter) {
      deps.traceWriter.write({
        traceId: session.id,
        action: "chat",
        providerId: parsed.provider,
        task: parsed.task,
        request: { promptSummary: prompt.slice(0, 100), fileCount: parsed.files?.length ?? 0 },
        response: { success: false, charLength: 0, error: message },
        latencyMs,
        reasoning,
      });
    }

    return {
      content: [
        {
          type: "text",
          text: `**Task failed**\n**Task ID:** ${session.id}\n**Error:** ${message}`,
        },
      ],
      isError: true,
    };
  }
}

async function handleTaskStatus(
  args: unknown,
  deps: AgentToolDeps,
): Promise<McpToolResult> {
  const parsed = AgentTaskStatusSchema.parse(args);
  const session = deps.sessionManager.getSession(parsed.task_id);

  if (!session) {
    return {
      content: [
        { type: "text", text: `Task not found: ${parsed.task_id}` },
      ],
      isError: true,
    };
  }

  let text = `**Task ID:** ${session.id}\n**Status:** ${session.status}\n**Created:** ${session.createdAt}\n**Updated:** ${session.updatedAt}`;

  if (session.config) {
    const config = session.config;
    if (config.provider) text += `\n**Provider:** ${config.provider}`;
    if (config.task) text += `\n**Task:** ${config.task}`;
  }

  if (session.result) {
    text += `\n\n---\n\n${session.result}`;
  }

  return { content: [{ type: "text", text }] };
}

async function handleDispatch(
  args: unknown,
  deps: AgentToolDeps,
): Promise<McpToolResult> {
  const parsed = AgentDispatchSchema.parse(args);

  const dispatcher = new TaskDispatcher(deps.registry, deps.jobManager, createAgentLoopFactory(deps));

  try {
    const result = await dispatcher.dispatch({
      assignments: parsed.assignments.map((a) => ({
        id: a.id,
        providerId: a.provider,
        task: a.task,
        files: a.files,
        dependsOn: a.depends_on,
      })),
      mergeStrategy: parsed.merge_strategy,
      timeoutMs: parsed.timeout_ms,
    });

    let text = `**Dispatch completed**\n**Assignments:** ${result.results.length}\n\n`;
    for (const r of result.results) {
      text += `### ${r.providerId} (${r.assignmentId}) — ${r.status}\n${r.output}\n\n`;
    }
    if (result.mergedOutput) {
      text += `---\n\n## Merged Output\n\n${result.mergedOutput}`;
    }

    // Record failures as dead_ends
    for (const r of result.results) {
      if (r.status === "error" || r.status === "timed_out") {
        deps.memoryFacade.store({
          content: `Dispatch task failed (${r.status}): ${r.providerId} — ${r.output}`,
          nodeType: "dead_end",
          topic: "technical",
          importance: 0.7,
          source: "auto",
          providerId: r.providerId,
        });
      }
    }

    // Run AutoQA if requested
    if (parsed.auto_qa) {
      const qa = new AutoQA(process.cwd());
      const qaResult = await qa.run({ designDoc: parsed.design_doc });
      text += `\n\n---\n\n## AutoQA Results\n\n${qaResult.summary}\n\n`;
      if (!qaResult.buildPassed) {
        text += `### Build Output\n\`\`\`\n${qaResult.buildOutput}\n\`\`\`\n\n`;
      }
      if (!qaResult.testsPassed) {
        text += `### Test Output\n\`\`\`\n${qaResult.testOutput}\n\`\`\`\n\n`;
      }
    }

    return { content: [{ type: "text", text }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `**Dispatch failed:** ${message}` }],
      isError: true,
    };
  }
}

async function handleCrossValidate(
  args: unknown,
  deps: AgentToolDeps,
): Promise<McpToolResult> {
  const parsed = AgentCrossValidateSchema.parse(args);

  const validator = new CrossValidator(deps.registry, getReadOnlyAdapter());

  try {
    const result = await validator.validate({
      items: parsed.items.map((i) => ({
        providerId: i.provider,
        content: i.content,
        task: i.task,
      })),
      validators: parsed.validators?.map((id) => deps.registry.get(id)),
      criteria: parsed.criteria,
    });

    let text = `**Cross-Validation ${result.overallPass ? "PASSED" : "FAILED"}**\n\n`;

    for (const review of result.reviews) {
      text += `### ${review.targetProvider} reviewed by ${review.reviewerProvider}\n`;
      text += `**Result:** ${review.passed ? "PASS" : "FAIL"}\n`;
      text += `**Feedback:** ${review.feedback}\n`;
      if (review.suggestedFixes) {
        text += `**Suggested Fixes:** ${review.suggestedFixes}\n`;
      }
      text += "\n";
    }

    if (result.conflicts.length > 0) {
      text += `## Conflicts\n${result.conflicts.map((c) => `- ${c}`).join("\n")}\n`;
    }

    // Record failures as dead_ends
    for (const review of result.reviews) {
      if (!review.passed) {
        deps.memoryFacade.store({
          content: `Validation failed for ${review.targetProvider}: ${review.feedback}`,
          nodeType: "dead_end",
          topic: "technical",
          importance: 0.8,
          source: "auto",
          providerId: review.targetProvider,
        });
      }
    }

    return { content: [{ type: "text", text }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `**Cross-validation failed:** ${message}` }],
      isError: true,
    };
  }
}

// ── Turn-based debate handlers ────────────────────────────────

async function handleDebateCreate(
  args: unknown,
  deps: AgentToolDeps,
): Promise<McpToolResult> {
  const parsed = AgentDebateCreateSchema.parse(args);

  // Validate all providers exist (skip "claude" — it's the host AI, not a registry entry)
  for (const id of parsed.providers) {
    if (id !== "claude") deps.registry.get(id);
  }

  // Create workspace document if requested
  let documentId: string | undefined;
  if (parsed.save_document) {
    const doc = await deps.documentManager.createReview({
      files: [],
      rules: parsed.goal ? [parsed.goal] : [],
    });
    documentId = doc.id;
  }

  // Create debate state
  const state = getDebateEngine().create({
    topic: parsed.topic,
    providerIds: parsed.providers,
    goal: parsed.goal,
    documentId,
  });

  return {
    content: [
      {
        type: "text",
        text: `**Debate created**\n**Debate ID:** ${state.id}\n**Topic:** ${parsed.topic}\n**Participants:** ${parsed.providers.join(", ")}${documentId ? `\n**Document ID:** ${documentId}` : ""}`,
      },
    ],
  };
}

async function handleDebateTurn(
  args: unknown,
  deps: AgentToolDeps,
): Promise<McpToolResult> {
  const parsed = AgentDebateTurnSchema.parse(args);

  const state = getDebateEngine().getState(parsed.debate_id);
  if (!state) {
    return {
      content: [{ type: "text", text: `Debate not found: ${parsed.debate_id}` }],
      isError: true,
    };
  }
  if (state.status === "concluded") {
    return {
      content: [{ type: "text", text: `Debate already concluded: ${parsed.debate_id}` }],
      isError: true,
    };
  }

  // ── Claude as independent participant ──────────────────────
  if (parsed.provider === "claude") {
    if (!parsed.claude_comment) {
      return {
        content: [{ type: "text", text: "provider: \"claude\" requires claude_comment to be set." }],
        isError: true,
      };
    }

    getDebateEngine().addTurn(parsed.debate_id, "claude", parsed.claude_comment);
    if (state.documentId) {
      await deps.documentManager.addComment(state.documentId, {
        author: "Claude",
        content: parsed.claude_comment,
      });
    }

    return {
      content: [
        {
          type: "text",
          text: `**[claude]:** ${parsed.claude_comment}`,
        },
      ],
    };
  }

  // ── Regular provider turn ─────────────────────────────────
  const provider = deps.registry.get(parsed.provider);

  // Inject Claude's comment first if provided
  if (parsed.claude_comment) {
    getDebateEngine().addTurn(parsed.debate_id, "claude", parsed.claude_comment);
    if (state.documentId) {
      await deps.documentManager.addComment(state.documentId, {
        author: "Claude",
        content: parsed.claude_comment,
      });
    }
  }

  // Build prompt with full conversation history and call provider
  const prompt = getDebateEngine().buildPromptForProvider(parsed.debate_id, parsed.provider);

  // Build reasoning metadata for trace
  const reasoning = deps.traceWriter ? {
    candidateProviders: state.providerIds,
    selectedProvider: parsed.provider,
    selectionReason: `Debate turn: ${parsed.provider}'s turn to respond`,
    memoryHit: false,
  } : undefined;

  const startTime = performance.now();

  let response;
  try {
    response = await getReadOnlyAdapter().chat(provider, { prompt });
  } catch (err) {
    const latencyMs = Math.round(performance.now() - startTime);
    const message = err instanceof Error ? err.message : String(err);
    if (deps.traceWriter) {
      deps.traceWriter.write({
        traceId: state.id,
        action: "debate_turn",
        providerId: parsed.provider,
        task: state.topic,
        request: { promptSummary: prompt.slice(0, 100), fileCount: 0 },
        response: { success: false, charLength: 0, error: message },
        latencyMs,
        reasoning,
      });
    }
    return {
      content: [{ type: "text", text: `**Debate turn failed (${parsed.provider}):** ${message}` }],
      isError: true,
    };
  }

  const latencyMs = Math.round(performance.now() - startTime);

  if (deps.traceWriter) {
    deps.traceWriter.write({
      traceId: state.id,
      action: "debate_turn",
      providerId: parsed.provider,
      task: state.topic,
      request: { promptSummary: prompt.slice(0, 100), fileCount: 0 },
      response: { success: true, charLength: response.text.length },
      latencyMs,
      reasoning,
    });
  }

  // Record provider's response as a turn
  getDebateEngine().addTurn(parsed.debate_id, parsed.provider, response.text);
  if (state.documentId) {
    await deps.documentManager.addComment(state.documentId, {
      author: parsed.provider,
      content: response.text,
    });
  }

  return {
    content: [
      {
        type: "text",
        text: `**[${parsed.provider}]:** ${response.text}`,
      },
    ],
  };
}

async function handleDebateConclude(
  args: unknown,
  deps: AgentToolDeps,
): Promise<McpToolResult> {
  const parsed = AgentDebateConcludeSchema.parse(args);

  const state = getDebateEngine().getState(parsed.debate_id);
  if (!state) {
    return {
      content: [{ type: "text", text: `Debate not found: ${parsed.debate_id}` }],
      isError: true,
    };
  }

  // Add summary as final turn if provided
  if (parsed.summary) {
    getDebateEngine().addTurn(parsed.debate_id, "claude", parsed.summary);
    if (state.documentId) {
      await deps.documentManager.addComment(state.documentId, {
        author: "Claude (Summary)",
        content: parsed.summary,
      });
    }
  }

  // Mark concluded
  getDebateEngine().conclude(parsed.debate_id);

  // Write quality scores to trace if provided
  if (parsed.quality_scores && deps.traceWriter) {
    for (const qs of parsed.quality_scores) {
      deps.traceWriter.updateQuality(state.id, qs.provider, {
        score: qs.score,
        evaluator: "claude",
        feedback: qs.feedback,
      });
    }
  }

  // Build transcript before cleanup
  const transcript = getDebateEngine().buildTurnTranscript(parsed.debate_id);

  // Release debate state to prevent memory leak
  getDebateEngine().delete(parsed.debate_id);

  // Store in memory
  deps.memoryFacade.store({
    content: `Debate on "${state.topic}": ${transcript}`,
    nodeType: "finding",
    topic: "context",
    importance: 0.7,
    source: "auto",
    providerId: state.providerIds.join(","),
  });

  let text = `**Debate concluded**\n**Debate ID:** ${parsed.debate_id}\n**Topic:** ${state.topic}\n**Turns:** ${state.turns.length}`;
  if (state.documentId) {
    text += `\n**Document ID:** ${state.documentId}`;
  }
  text += `\n\n---\n\n${transcript}`;

  return { content: [{ type: "text", text }] };
}

// ── Document review handler ──────────────────────────────────

async function handleDebateReview(
  args: unknown,
  deps: AgentToolDeps,
): Promise<McpToolResult> {
  const parsed = AgentDebateReviewSchema.parse(args);

  const defaultReviewPrompt = [
    "Review the following document carefully.",
    "Respond with JSON only:",
    "{ \"agrees\": true/false, \"feedback\": \"specific issues or why you agree\", \"suggestions\": \"concrete changes if you disagree, or omit\" }",
  ].join("\n");

  const reviewPrompt = parsed.review_prompt ?? defaultReviewPrompt;

  // Get linked debate's document ID for comment tracking
  let documentId: string | undefined;
  if (parsed.debate_id) {
    const state = getDebateEngine().getState(parsed.debate_id);
    documentId = state?.documentId;
  }

  const reviews: Array<{ provider: string; agrees: boolean; feedback: string; suggestions?: string }> = [];

  // Send document to each provider for review (in parallel)
  const reviewPromises = parsed.providers.map(async (providerId) => {
    if (providerId === "claude") return null; // Claude reviews are added via claude_comment

    const provider = deps.registry.get(providerId);
    const prompt = `${reviewPrompt}\n\n---\n\n${parsed.document}`;

    try {
      const response = await getReadOnlyAdapter().chat(provider, { prompt });

      // Parse structured response
      const jsonParsed = extractJsonFromText(response.text) as Record<string, unknown> | null;
      const review = {
        provider: providerId,
        agrees: jsonParsed ? Boolean(jsonParsed.agrees) : false,
        feedback: jsonParsed ? String(jsonParsed.feedback ?? "") : response.text,
        suggestions: jsonParsed?.suggestions ? String(jsonParsed.suggestions) : undefined,
      };

      // Track in workspace document if linked
      if (documentId) {
        await deps.documentManager.addComment(documentId, {
          author: `${providerId} (review)`,
          content: `**${review.agrees ? "AGREES" : "DISAGREES"}**\n\n${review.feedback}${review.suggestions ? `\n\n**Suggestions:** ${review.suggestions}` : ""}`,
        });
      }

      return review;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        provider: providerId,
        agrees: false,
        feedback: `[Review failed: ${message}]`,
      };
    }
  });

  const settled = await Promise.all(reviewPromises);
  for (const review of settled) {
    if (review) reviews.push(review);
  }

  const allAgree = reviews.length > 0 && reviews.every((r) => r.agrees);

  // Build output
  let text = `**Document Review** — ${allAgree ? "ALL AGREE ✓" : "DISAGREEMENTS FOUND"}\n\n`;
  for (const review of reviews) {
    text += `### ${review.provider}: ${review.agrees ? "AGREES" : "DISAGREES"}\n`;
    text += `${review.feedback}\n`;
    if (review.suggestions) {
      text += `**Suggestions:** ${review.suggestions}\n`;
    }
    text += "\n";
  }

  if (!allAgree) {
    text += `---\n\n**Next step:** Revise the document addressing the feedback above, then call \`agent_debate_review\` again to check for consensus.`;
  }

  return { content: [{ type: "text", text }] };
}

// ── Task chain handlers ──────────────────────────────────────

async function handleTaskChainCreate(
  args: unknown,
  deps: AgentToolDeps,
): Promise<McpToolResult> {
  const parsed = AgentTaskChainCreateSchema.parse(args);

  // Validate providers exist (skip "claude")
  for (const step of parsed.steps) {
    if (step.provider !== "claude") deps.registry.get(step.provider);
  }

  const engine = getTaskChainEngine(deps.registry);
  const state = engine.create({ steps: parsed.steps });

  const stepsPreview = parsed.steps
    .map((s) => `  ${s.id}: ${s.description} → ${s.provider}${s.checkpoint ? " [checkpoint]" : ""}`)
    .join("\n");

  return {
    content: [
      {
        type: "text",
        text: `**Task chain created**\n**Chain ID:** ${state.id}\n**Steps:** ${parsed.steps.length}\n\n${stepsPreview}\n\nUse \`agent_task_chain_step\` to execute steps.`,
      },
    ],
  };
}

async function handleTaskChainStep(
  args: unknown,
  deps: AgentToolDeps,
): Promise<McpToolResult> {
  const parsed = AgentTaskChainStepSchema.parse(args);

  const engine = getTaskChainEngine(deps.registry);
  const state = engine.getState(parsed.chain_id);
  if (!state) {
    return {
      content: [{ type: "text", text: `Chain not found: ${parsed.chain_id}` }],
      isError: true,
    };
  }

  try {
    const result = await engine.executeStep(parsed.chain_id, parsed.step_id, parsed.override_prompt);

    let text = `**Step executed: ${result.stepId}**\n**Provider:** ${result.provider}\n**Status:** ${result.status}\n\n${result.output}`;

    if (result.validationResult) {
      text += `\n\n---\n**Validation:** ${result.validationResult.passed ? "PASS" : "FAIL"}\n${result.validationResult.feedback}`;
    }

    // Check updated chain state
    const updatedState = engine.getState(parsed.chain_id)!;
    text += `\n\n---\n**Chain status:** ${updatedState.status}`;

    if (updatedState.status === "paused") {
      text += `\n\n⚠️ **Checkpoint reached.** Review the output above before calling \`agent_task_chain_step\` to continue.`;
    }

    if (updatedState.status === "running" && updatedState.currentStepIndex < updatedState.steps.length) {
      const nextStep = updatedState.steps[updatedState.currentStepIndex];
      text += `\n**Next step:** ${nextStep.id} — ${nextStep.description} (${nextStep.provider})`;
    }

    return { content: [{ type: "text", text }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `**Step execution failed:** ${message}` }],
      isError: true,
    };
  }
}

async function handleTaskChainStepAsync(
  args: unknown,
  deps: AgentToolDeps,
): Promise<McpToolResult> {
  const parsed = AgentTaskChainStepAsyncSchema.parse(args);

  const engine = getTaskChainEngine(deps.registry);
  const state = engine.getState(parsed.chain_id);
  if (!state) {
    return {
      content: [{ type: "text", text: `Chain not found: ${parsed.chain_id}` }],
      isError: true,
    };
  }

  try {
    const { stepId, status } = engine.startStepAsync(
      parsed.chain_id,
      parsed.step_id,
      parsed.override_prompt,
    );

    const step = state.steps.find((s) => s.id === stepId);
    const text =
      `**Step started in background:** ${stepId}\n` +
      `**Provider:** ${step?.provider ?? "unknown"}\n` +
      `**Status:** ${status}\n\n` +
      `Use \`agent_task_chain_await\` with step_id "${stepId}" to collect the result, ` +
      `or \`agent_task_chain_status\` to check progress. You can continue other work in the meantime.`;

    return { content: [{ type: "text", text }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `**Async step start failed:** ${message}` }],
      isError: true,
    };
  }
}

async function handleTaskChainAwait(
  args: unknown,
  deps: AgentToolDeps,
): Promise<McpToolResult> {
  const parsed = AgentTaskChainAwaitSchema.parse(args);

  const engine = getTaskChainEngine(deps.registry);

  if (!engine.isStepRunning(parsed.chain_id, parsed.step_id)) {
    // Check if step already has a result
    const state = engine.getState(parsed.chain_id);
    if (!state) {
      return {
        content: [{ type: "text", text: `Chain not found: ${parsed.chain_id}` }],
        isError: true,
      };
    }
    const existing = state.results.find((r) => r.stepId === parsed.step_id);
    if (existing) {
      let text = `**Step already completed: ${existing.stepId}**\n**Status:** ${existing.status}\n\n${existing.output}`;
      if (existing.validationResult) {
        text += `\n\n---\n**Validation:** ${existing.validationResult.passed ? "PASS" : "FAIL"}\n${existing.validationResult.feedback}`;
      }
      return { content: [{ type: "text", text }] };
    }
    return {
      content: [{ type: "text", text: `Step "${parsed.step_id}" is not running and has no result.` }],
      isError: true,
    };
  }

  try {
    const result = await engine.awaitStep(parsed.chain_id, parsed.step_id);
    if (!result) {
      return {
        content: [{ type: "text", text: `Step "${parsed.step_id}" finished before await.` }],
        isError: true,
      };
    }

    let text = `**Step completed: ${result.stepId}**\n**Provider:** ${result.provider}\n**Status:** ${result.status}\n\n${result.output}`;

    if (result.validationResult) {
      text += `\n\n---\n**Validation:** ${result.validationResult.passed ? "PASS" : "FAIL"}\n${result.validationResult.feedback}`;
    }

    const updatedState = engine.getState(parsed.chain_id)!;
    text += `\n\n---\n**Chain status:** ${updatedState.status}`;

    if (updatedState.status === "running" && updatedState.currentStepIndex < updatedState.steps.length) {
      const nextStep = updatedState.steps[updatedState.currentStepIndex];
      text += `\n**Next step:** ${nextStep.id} — ${nextStep.description} (${nextStep.provider})`;
    }

    return { content: [{ type: "text", text }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `**Await failed:** ${message}` }],
      isError: true,
    };
  }
}

async function handleTaskChainStatus(
  args: unknown,
  deps: AgentToolDeps,
): Promise<McpToolResult> {
  const parsed = AgentTaskChainStatusSchema.parse(args);

  const engine = getTaskChainEngine(deps.registry);
  const state = engine.getState(parsed.chain_id);
  if (!state) {
    return {
      content: [{ type: "text", text: `Chain not found: ${parsed.chain_id}` }],
      isError: true,
    };
  }

  const runningSteps = engine.getPendingSteps(parsed.chain_id);

  let text = `**Chain ID:** ${state.id}\n**Status:** ${state.status}\n**Progress:** ${state.results.length}/${state.steps.length} steps\n`;

  if (runningSteps.length > 0) {
    text += `**Running in background:** ${runningSteps.join(", ")}\n`;
  }

  text += "\n";

  for (const step of state.steps) {
    const result = state.results.find((r) => r.stepId === step.id);
    const isRunning = runningSteps.includes(step.id);
    const status = result ? result.status : isRunning ? "running" : "pending";
    const preview = result ? result.output.slice(0, 100) + (result.output.length > 100 ? "..." : "") : "";
    text += `- **${step.id}** (${step.provider}): ${status}${preview ? ` — ${preview}` : ""}\n`;
  }

  return { content: [{ type: "text", text }] };
}


async function handleChangesReview(
  args: unknown,
  deps: AgentToolDeps,
): Promise<McpToolResult> {
  const parsed = AgentChangesReviewSchema.parse(args);

  const tracker = getFileChangeTracker();
  const worktreePath = tracker.getWorktreePath(parsed.task_id);
  if (!worktreePath) {
    return {
      content: [{ type: "text", text: `No isolated worktree found for task: ${parsed.task_id}` }],
      isError: true,
    };
  }

  const report = tracker.captureChanges(parsed.task_id, "unknown");

  let text = `**File Change Review**\n**Task ID:** ${parsed.task_id}\n**Worktree:** ${report.worktreePath}\n**Branch:** ${report.branch}\n**Files changed:** ${report.changes.length}\n\n`;

  if (report.changes.length === 0) {
    text += "No changes detected.";
  } else {
    text += `### Diff Stat\n\`\`\`\n${report.diffStat}\n\`\`\`\n\n### Changes\n\`\`\`diff\n${report.fullDiff}\n\`\`\``;
  }

  return { content: [{ type: "text", text }] };
}

async function handleChangesAccept(
  args: unknown,
  deps: AgentToolDeps,
): Promise<McpToolResult> {
  const parsed = AgentChangesAcceptSchema.parse(args);

  const tracker = getFileChangeTracker();
  try {
    const result = tracker.acceptChanges(parsed.task_id, parsed.message);
    return {
      content: [
        {
          type: "text",
          text: `**Changes accepted**\n**Task ID:** ${parsed.task_id}\n**Merged files:** ${result.merged.length}\n\n${result.merged.map((f) => `- ${f}`).join("\n") || "(no files)"}`,
        },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `**Accept failed:** ${message}` }],
      isError: true,
    };
  }
}

async function handleChangesReject(
  args: unknown,
  deps: AgentToolDeps,
): Promise<McpToolResult> {
  const parsed = AgentChangesRejectSchema.parse(args);

  const tracker = getFileChangeTracker();
  tracker.rejectChanges(parsed.task_id);

  let text = `**Changes rejected**\n**Task ID:** ${parsed.task_id}`;
  if (parsed.reason) {
    text += `\n**Reason:** ${parsed.reason}`;
  }

  return { content: [{ type: "text", text }] };
}

async function handleSessionList(
  args: unknown,
  deps: AgentToolDeps,
): Promise<McpToolResult> {
  const parsed = SessionListSchema.parse(args);
  let sessions = deps.sessionManager.listSessions();

  if (parsed.type !== "all") {
    sessions = sessions.filter((s: any) => s.type === parsed.type);
  }
  if (parsed.status !== "all") {
    sessions = sessions.filter((s: any) => s.status === parsed.status);
  }

  if (sessions.length === 0) {
    return {
      content: [{ type: "text", text: "No sessions found matching the filter." }],
    };
  }

  let text = `# Sessions\n\n**Total:** ${sessions.length}\n\n`;
  for (const s of sessions) {
    text += `- **${s.id}** | Type: ${s.type} | Status: ${s.status} | Created: ${s.createdAt}\n`;
  }

  return { content: [{ type: "text", text }] };
}

// ── Dispatcher ───────────────────────────────────────────────

export async function handleTool(
  name: string,
  args: unknown,
  deps: AgentToolDeps,
): Promise<McpToolResult> {
  switch (name) {
    case "agent_debate_start":
      return handleDebateStart(args, deps);
    case "agent_debate_status":
      return handleDebateStatus(args, deps);
    case "agent_assign_task":
      return handleAssignTask(args, deps);
    case "agent_task_status":
      return handleTaskStatus(args, deps);
    case "agent_dispatch":
      return handleDispatch(args, deps);
    case "agent_cross_validate":
      return handleCrossValidate(args, deps);
    case "agent_debate_create":
      return handleDebateCreate(args, deps);
    case "agent_debate_turn":
      return handleDebateTurn(args, deps);
    case "agent_debate_conclude":
      return handleDebateConclude(args, deps);
    case "agent_debate_review":
      return handleDebateReview(args, deps);
    case "agent_task_chain_create":
      return handleTaskChainCreate(args, deps);
    case "agent_task_chain_step":
      return handleTaskChainStep(args, deps);
    case "agent_task_chain_step_async":
      return handleTaskChainStepAsync(args, deps);
    case "agent_task_chain_await":
      return handleTaskChainAwait(args, deps);
    case "agent_task_chain_status":
      return handleTaskChainStatus(args, deps);
    case "agent_changes_review":
      return handleChangesReview(args, deps);
    case "agent_changes_accept":
      return handleChangesAccept(args, deps);
    case "agent_changes_reject":
      return handleChangesReject(args, deps);
    case "session_list":
      return handleSessionList(args, deps);
    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
}
