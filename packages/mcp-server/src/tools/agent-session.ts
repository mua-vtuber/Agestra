import { z } from "zod";
import type { ProviderRegistry, JobManager } from "@agestra/core";
import type { TraceWriter } from "@agestra/core";
import type { SessionManager } from "@agestra/agents";
import type { DocumentManager } from "@agestra/workspace";
import type { MemoryFacade } from "@agestra/memory";
import { DebateEngine, TaskDispatcher, CrossValidator } from "@agestra/agents";
import type { DebateConfig, EnhancedDebateConfig } from "@agestra/agents";

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

// Shared debate engine instance for turn-based debates
const debateEngine = new DebateEngine();

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
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
        "End a debate session and generate the final transcript. Optionally add Claude's summary.",
      inputSchema: {
        type: "object" as const,
        properties: {
          debate_id: { type: "string", description: "Debate session ID to conclude" },
          summary: { type: "string", description: "Claude's final summary of the debate" },
        },
        required: ["debate_id"],
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

  // Fetch dead_end context from memory
  deps.memoryFacade.search(parsed.topic, { nodeType: "dead_end" as any, limit: 5 })
    .then((deadEnds) => {
      if (deadEnds.length > 0) {
        debateConfig.deadEndContext = deadEnds
          .map((d) => `- ${d.node.content}`)
          .join("\n");
      }
    })
    .catch(() => { /* non-critical */ });

  // Run debate (non-blocking)
  const engine = new DebateEngine();
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

  const startTime = performance.now();
  try {
    const response = await provider.chat({ prompt });
    const latencyMs = Math.round(performance.now() - startTime);

    if (deps.traceWriter) {
      deps.traceWriter.write({
        traceId: session.id,
        action: "chat",
        providerId: parsed.provider,
        task: parsed.task,
        request: { promptSummary: prompt.slice(0, 100), fileCount: parsed.files?.length ?? 0 },
        response: { success: true, charLength: response.text.length },
        latencyMs,
      });
    }

    deps.sessionManager.completeSession(session.id, response.text);

    return {
      content: [
        {
          type: "text",
          text: `**Task completed**\n**Task ID:** ${session.id}\n**Provider:** ${parsed.provider}\n\n${response.text}`,
        },
      ],
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

  const dispatcher = new TaskDispatcher(deps.registry, deps.jobManager);

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

  const validator = new CrossValidator(deps.registry);

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
  const state = debateEngine.create({
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

  const state = debateEngine.getState(parsed.debate_id);
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

    debateEngine.addTurn(parsed.debate_id, "claude", parsed.claude_comment);
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
    debateEngine.addTurn(parsed.debate_id, "claude", parsed.claude_comment);
    if (state.documentId) {
      await deps.documentManager.addComment(state.documentId, {
        author: "Claude",
        content: parsed.claude_comment,
      });
    }
  }

  // Build prompt with full conversation history and call provider
  const prompt = debateEngine.buildPromptForProvider(parsed.debate_id, parsed.provider);
  const startTime = performance.now();
  const response = await provider.chat({ prompt });
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
    });
  }

  // Record provider's response as a turn
  debateEngine.addTurn(parsed.debate_id, parsed.provider, response.text);
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

  const state = debateEngine.getState(parsed.debate_id);
  if (!state) {
    return {
      content: [{ type: "text", text: `Debate not found: ${parsed.debate_id}` }],
      isError: true,
    };
  }

  // Add summary as final turn if provided
  if (parsed.summary) {
    debateEngine.addTurn(parsed.debate_id, "claude", parsed.summary);
    if (state.documentId) {
      await deps.documentManager.addComment(state.documentId, {
        author: "Claude (Summary)",
        content: parsed.summary,
      });
    }
  }

  // Mark concluded
  debateEngine.conclude(parsed.debate_id);

  // Build transcript
  const transcript = debateEngine.buildTurnTranscript(parsed.debate_id);

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
    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
}
