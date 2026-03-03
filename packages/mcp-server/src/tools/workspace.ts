import { z } from "zod";
import type { ProviderRegistry, AIProvider } from "@agestra/core";
import type { DocumentManager } from "@agestra/workspace";

// ── Zod schemas ──────────────────────────────────────────────

const WorkspaceCreateReviewSchema = z.object({
  files: z.array(z.string()).min(1).describe("File paths to include in the review"),
  rules: z.array(z.string()).describe("Review rules/guidelines to apply"),
});

const WorkspaceRequestReviewSchema = z.object({
  doc_id: z.string().describe("Document ID to request review for"),
  provider: z.string().describe("Provider ID to perform the review"),
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
        "Request an AI provider to perform a code review on an existing review document.",
      inputSchema: {
        type: "object" as const,
        properties: {
          doc_id: { type: "string", description: "Document ID to request review for" },
          provider: { type: "string", description: "Provider ID to perform the review" },
        },
        required: ["doc_id", "provider"],
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

  // Validate provider exists
  const provider = deps.registry.get(parsed.provider);

  // Read the document
  const doc = await deps.documentManager.read(parsed.doc_id);

  // Send to provider for review
  const response = await provider.chat({
    prompt: `Please review the following document and provide feedback:\n\n${doc.content}`,
    system: "You are a code reviewer. Provide detailed, actionable feedback.",
  });

  // Add the review as a comment
  await deps.documentManager.addComment(parsed.doc_id, {
    author: `AI (${parsed.provider})`,
    content: response.text,
  });

  return {
    content: [
      {
        type: "text",
        text: `**Review completed**\n**Document ID:** ${parsed.doc_id}\n**Reviewer:** ${parsed.provider}\n**Model:** ${response.model}\n\n${response.text}`,
      },
    ],
  };
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
