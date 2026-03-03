import { z } from "zod";
import type { ProviderRegistry, AIProvider } from "@agestra/core";
import type { DocumentManager } from "@agestra/workspace";
import type { SessionManager } from "@agestra/agents";

// ── Zod schemas ──────────────────────────────────────────────

const WorkspaceCreateReviewSchema = z.object({
  files: z.array(z.string()).min(1).describe("File paths to include in the review"),
  rules: z.array(z.string()).describe("Review rules/guidelines to apply"),
});

const WorkspaceRequestReviewSchema = z.object({
  doc_id: z.string().describe("Document ID to request review for"),
  provider: z.union([
    z.string(),
    z.array(z.string()).min(1),
  ]).describe("Provider ID(s) to perform the review"),
});

const WorkspaceReviewStatusSchema = z.object({
  session_id: z.string().describe("Session ID returned by workspace_request_review"),
});

const WorkspaceAddCommentSchema = z.object({
  doc_id: z.string().describe("Document ID to comment on"),
  author: z.string().describe("Comment author name"),
  content: z.string().describe("Comment content"),
});

const WorkspaceReadSchema = z.object({
  doc_id: z.string().describe("Document ID to read"),
});

// ── Types ────────────────────────────────────────────────────

export interface WorkspaceToolDeps {
  registry: ProviderRegistry;
  documentManager: DocumentManager;
  sessionManager: SessionManager;
}

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// ── Tool definitions ─────────────────────────────────────────

export function getTools() {
  return [
    {
      name: "workspace_create_review",
      description:
        "Create a code review document for the specified files with given review rules.",
      inputSchema: {
        type: "object" as const,
        properties: {
          files: {
            type: "array",
            items: { type: "string" },
            description: "File paths to include in the review",
          },
          rules: {
            type: "array",
            items: { type: "string" },
            description: "Review rules/guidelines to apply",
          },
        },
        required: ["files", "rules"],
      },
    },
    {
      name: "workspace_request_review",
      description:
        "Request AI provider(s) to perform a code review on an existing review document. Returns immediately with a session ID. Use workspace_review_status to check progress.",
      inputSchema: {
        type: "object" as const,
        properties: {
          doc_id: { type: "string", description: "Document ID to request review for" },
          provider: {
            oneOf: [
              { type: "string", description: "Single provider ID" },
              { type: "array", items: { type: "string" }, description: "Multiple provider IDs" },
            ],
            description: "Provider ID(s) to perform the review",
          },
        },
        required: ["doc_id", "provider"],
      },
    },
    {
      name: "workspace_review_status",
      description:
        "Check the status of an async review session started by workspace_request_review.",
      inputSchema: {
        type: "object" as const,
        properties: {
          session_id: { type: "string", description: "Session ID returned by workspace_request_review" },
        },
        required: ["session_id"],
      },
    },
    {
      name: "workspace_add_comment",
      description:
        "Add a comment to an existing review document.",
      inputSchema: {
        type: "object" as const,
        properties: {
          doc_id: { type: "string", description: "Document ID to comment on" },
          author: { type: "string", description: "Comment author name" },
          content: { type: "string", description: "Comment content" },
        },
        required: ["doc_id", "author", "content"],
      },
    },
    {
      name: "workspace_read",
      description:
        "Read the contents of a review document.",
      inputSchema: {
        type: "object" as const,
        properties: {
          doc_id: { type: "string", description: "Document ID to read" },
        },
        required: ["doc_id"],
      },
    },
  ];
}

// ── Handlers ─────────────────────────────────────────────────

async function handleCreateReview(
  args: unknown,
  deps: WorkspaceToolDeps,
): Promise<McpToolResult> {
  const parsed = WorkspaceCreateReviewSchema.parse(args);

  const doc = await deps.documentManager.createReview({
    files: parsed.files,
    rules: parsed.rules,
  });

  return {
    content: [
      {
        type: "text",
        text: `**Review created**\n**Document ID:** ${doc.id}\n**Path:** ${doc.path}\n**Files:** ${parsed.files.join(", ")}\n**Rules:** ${parsed.rules.length}`,
      },
    ],
  };
}

async function handleRequestReview(
  args: unknown,
  deps: WorkspaceToolDeps,
): Promise<McpToolResult> {
  const parsed = WorkspaceRequestReviewSchema.parse(args);

  // Normalize provider to array
  const providerIds = Array.isArray(parsed.provider)
    ? parsed.provider
    : [parsed.provider];

  // Fail-fast: validate all providers exist
  const providers: Array<{ id: string; provider: AIProvider }> = [];
  for (const id of providerIds) {
    const provider = deps.registry.get(id);
    providers.push({ id, provider });
  }

  // Fail-fast: validate document exists
  const doc = await deps.documentManager.read(parsed.doc_id);

  // Create a session to track the async review
  const session = deps.sessionManager.createSession("review", {
    doc_id: parsed.doc_id,
    providers: providerIds,
    completed: [] as string[],
    failed: [] as string[],
  });

  deps.sessionManager.updateSessionStatus(session.id, "in_progress");

  // Fire-and-forget: launch reviews in parallel
  const reviewPromises = providers.map(async ({ id, provider }) => {
    try {
      const response = await provider.chat({
        prompt: `Please review the following document and provide feedback:\n\n${doc.content}`,
        system: "You are a code reviewer. Provide detailed, actionable feedback.",
      });

      await deps.documentManager.addComment(parsed.doc_id, {
        author: `AI (${id})`,
        content: response.text,
      });

      // Track completion
      const current = deps.sessionManager.getSession(session.id);
      if (current) {
        const completed = (current.config.completed as string[]) || [];
        completed.push(id);
        current.config.completed = completed;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // Add error as comment so it's visible in the document
      try {
        await deps.documentManager.addComment(parsed.doc_id, {
          author: `AI (${id})`,
          content: `**Review failed:** ${msg}`,
        });
      } catch {
        // Ignore comment write failure
      }

      // Track failure
      const current = deps.sessionManager.getSession(session.id);
      if (current) {
        const failed = (current.config.failed as string[]) || [];
        failed.push(id);
        current.config.failed = failed;
      }
    }
  });

  // When all providers finish, mark the session complete
  Promise.all(reviewPromises).then(() => {
    try {
      const current = deps.sessionManager.getSession(session.id);
      const completed = (current?.config.completed as string[]) || [];
      const failed = (current?.config.failed as string[]) || [];
      const summary = `Completed: ${completed.join(", ") || "none"}. Failed: ${failed.join(", ") || "none"}.`;

      if (failed.length === providerIds.length) {
        deps.sessionManager.updateSessionStatus(session.id, "failed");
      }
      deps.sessionManager.completeSession(session.id, summary);
    } catch {
      // Best-effort session finalization
    }
  });

  return {
    content: [
      {
        type: "text",
        text: `**Review started (async)**\n**Session ID:** ${session.id}\n**Document ID:** ${parsed.doc_id}\n**Providers:** ${providerIds.join(", ")}\n\nUse \`workspace_review_status\` with session_id to check progress.`,
      },
    ],
  };
}

async function handleReviewStatus(
  args: unknown,
  deps: WorkspaceToolDeps,
): Promise<McpToolResult> {
  const parsed = WorkspaceReviewStatusSchema.parse(args);

  const session = deps.sessionManager.getSession(parsed.session_id);
  if (!session) {
    return {
      content: [{ type: "text", text: `Session not found: ${parsed.session_id}` }],
      isError: true,
    };
  }

  const providers = (session.config.providers as string[]) || [];
  const completed = (session.config.completed as string[]) || [];
  const failed = (session.config.failed as string[]) || [];
  const pending = providers.filter((p) => !completed.includes(p) && !failed.includes(p));

  let text = `**Review Session Status**\n`;
  text += `**Session ID:** ${session.id}\n`;
  text += `**Status:** ${session.status}\n`;
  text += `**Document:** ${session.config.doc_id}\n`;
  text += `**Providers:** ${providers.join(", ")}\n\n`;
  text += `- Completed: ${completed.join(", ") || "none"}\n`;
  text += `- Failed: ${failed.join(", ") || "none"}\n`;
  text += `- Pending: ${pending.join(", ") || "none"}\n`;

  if (session.result) {
    text += `\n**Result:** ${session.result}`;
  }

  return { content: [{ type: "text", text }] };
}

async function handleAddComment(
  args: unknown,
  deps: WorkspaceToolDeps,
): Promise<McpToolResult> {
  const parsed = WorkspaceAddCommentSchema.parse(args);

  await deps.documentManager.addComment(parsed.doc_id, {
    author: parsed.author,
    content: parsed.content,
  });

  return {
    content: [
      {
        type: "text",
        text: `**Comment added**\n**Document ID:** ${parsed.doc_id}\n**Author:** ${parsed.author}\n\n${parsed.content}`,
      },
    ],
  };
}

async function handleRead(
  args: unknown,
  deps: WorkspaceToolDeps,
): Promise<McpToolResult> {
  const parsed = WorkspaceReadSchema.parse(args);

  const doc = await deps.documentManager.read(parsed.doc_id);

  return {
    content: [
      {
        type: "text",
        text: `**Document ID:** ${doc.id}\n**Path:** ${doc.path}\n\n${doc.content}`,
      },
    ],
  };
}

// ── Dispatcher ───────────────────────────────────────────────

export async function handleTool(
  name: string,
  args: unknown,
  deps: WorkspaceToolDeps,
): Promise<McpToolResult> {
  switch (name) {
    case "workspace_create_review":
      return handleCreateReview(args, deps);
    case "workspace_request_review":
      return handleRequestReview(args, deps);
    case "workspace_review_status":
      return handleReviewStatus(args, deps);
    case "workspace_add_comment":
      return handleAddComment(args, deps);
    case "workspace_read":
      return handleRead(args, deps);
    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
}
