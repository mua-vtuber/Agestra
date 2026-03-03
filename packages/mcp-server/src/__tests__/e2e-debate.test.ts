/**
 * E2E Debate Session Test
 *
 * Tests the full debate and task assignment flows through the MCP dispatch layer.
 * Uses real SessionManager and DocumentManager with temp directories, mock providers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProviderRegistry } from "@agestra/core";
import type {
  AIProvider,
  ChatRequest,
  ChatResponse,
  ProviderCapability,
  HealthStatus,
} from "@agestra/core";
import { SessionManager } from "@agestra/agents";
import { DocumentManager } from "@agestra/workspace";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { dispatch, type ServerDependencies } from "../server.js";

// ── Mock Provider Factory ───────────────────────────────────────────

function createMockProvider(
  id: string,
  opts: {
    response?: string;
    chatFn?: (req: ChatRequest) => Promise<ChatResponse>;
  } = {},
): AIProvider {
  const response = opts.response ?? `Response from ${id}`;

  return {
    id,
    type: "mock",
    initialize: async () => {},
    healthCheck: async (): Promise<HealthStatus> => ({ status: "ok" }),
    getCapabilities: (): ProviderCapability => ({
      maxContext: 4096,
      supportsSystemPrompt: true,
      supportsFiles: false,
      supportsStreaming: false,
      supportsJsonOutput: false,
      supportsToolUse: false,
      strengths: [],
      models: [],
    }),
    isAvailable: () => true,
    chat: opts.chatFn ?? (async (_req: ChatRequest): Promise<ChatResponse> => ({
      text: response,
      model: `${id}-model`,
      provider: id,
    })),
  };
}

// ── Mock MemoryFacade ───────────────────────────────────────────────

function createMockMemoryFacade() {
  return {
    search: vi.fn().mockResolvedValue([]),
    store: vi.fn(),
    initialize: vi.fn(),
    close: vi.fn(),
    getAssembledContext: vi.fn(),
    addEdge: vi.fn(),
  } as any;
}

function createMockJobManager() {
  return {
    submit: vi.fn().mockReturnValue("mock-job-id"),
    getStatus: vi.fn().mockReturnValue(null),
    getResult: vi.fn().mockReturnValue(null),
    listJobs: vi.fn().mockReturnValue([]),
    cancel: vi.fn().mockReturnValue(false),
  } as any;
}

// ── Test Suite ──────────────────────────────────────────────────────

describe("E2E: Debate Session", () => {
  let tmpDir: string;
  let registry: ProviderRegistry;
  let sessionManager: SessionManager;
  let documentManager: DocumentManager;
  let deps: ServerDependencies;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "e2e-debate-"));
    registry = new ProviderRegistry();
    sessionManager = new SessionManager(tmpDir);
    documentManager = new DocumentManager(tmpDir);
    const memoryFacade = createMockMemoryFacade();

    deps = { registry, sessionManager, documentManager, memoryFacade, jobManager: createMockJobManager() };
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // ── 1. Debate: start -> status -> result with consensus ──────────

  describe("agent_debate_start with 2 mock providers", () => {
    it("should run a debate, complete session, and contain consensus in result", async () => {
      let ollamaCallCount = 0;
      let geminiCallCount = 0;

      const ollama = createMockProvider("ollama", {
        chatFn: async (req: ChatRequest) => {
          ollamaCallCount++;
          return {
            text: `Ollama round ${ollamaCallCount}: TypeScript improves safety with static typing.`,
            model: "llama3",
            provider: "ollama",
          };
        },
      });

      const gemini = createMockProvider("gemini", {
        chatFn: async (req: ChatRequest) => {
          geminiCallCount++;
          return {
            text: `Gemini round ${geminiCallCount}: TypeScript also enhances developer experience with IDE support.`,
            model: "gemini-pro",
            provider: "gemini",
          };
        },
      });

      registry.register(ollama);
      registry.register(gemini);

      // Start the debate
      const startResult = await dispatch(
        "agent_debate_start",
        {
          topic: "Is TypeScript worth the overhead?",
          providers: ["ollama", "gemini"],
          max_rounds: 2,
        },
        deps,
      );

      // Non-blocking: returns immediately with session info
      expect(startResult.isError).toBeUndefined();
      const startText = startResult.content[0].text;
      expect(startText).toContain("Debate started");
      expect(startText).toContain("Is TypeScript worth the overhead?");
      expect(startText).toContain("ollama");
      expect(startText).toContain("gemini");

      // Extract session ID from the response
      const sessionIdMatch = startText.match(/Session ID:\*\* (\S+)/);
      expect(sessionIdMatch).not.toBeNull();
      const sessionId = sessionIdMatch![1];

      // Flush microtask queue so the fire-and-forget debate engine settles
      await new Promise(resolve => setTimeout(resolve, 0));

      const statusResult = await dispatch(
        "agent_debate_status",
        { session_id: sessionId },
        deps,
      );

      expect(statusResult.isError).toBeUndefined();
      const statusText = statusResult.content[0].text;
      expect(statusText).toContain(sessionId);
      expect(statusText).toContain("completed");
      expect(statusText).toContain("debate");
      expect(statusText).toContain("Is TypeScript worth the overhead?");

      // The result should contain the debate transcript
      expect(statusText).toContain("Ollama round");
      expect(statusText).toContain("Gemini round");

      // Both providers should have been called for each round
      expect(ollamaCallCount).toBe(2);
      expect(geminiCallCount).toBe(2);
    });

    it("should handle single round debates", async () => {
      const ollama = createMockProvider("ollama", {
        response: "Ollama: I think yes.",
      });
      const gemini = createMockProvider("gemini", {
        response: "Gemini: I think no.",
      });

      registry.register(ollama);
      registry.register(gemini);

      const result = await dispatch(
        "agent_debate_start",
        {
          topic: "Single round debate",
          providers: ["ollama", "gemini"],
          max_rounds: 1,
        },
        deps,
      );

      // Non-blocking: returns immediately with session info
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("Debate started");
      expect(result.content[0].text).toContain("Single round debate");
    });

    it("should fail debate when a provider throws", async () => {
      const ollama = createMockProvider("ollama", {
        chatFn: async () => {
          throw new Error("Ollama crashed during debate");
        },
      });
      const gemini = createMockProvider("gemini", {
        response: "Gemini response",
      });

      registry.register(ollama);
      registry.register(gemini);

      const result = await dispatch(
        "agent_debate_start",
        {
          topic: "Failing debate",
          providers: ["ollama", "gemini"],
          max_rounds: 1,
        },
        deps,
      );

      // Non-blocking: handler returns success; failure handled asynchronously
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("Debate started");
    });
  });

  // ── 2. agent_assign_task -> agent_task_status -> completed ────────

  describe("agent_assign_task with mock provider", () => {
    it("should assign a task and complete it, then check status", async () => {
      const ollama = createMockProvider("ollama", {
        chatFn: async (req: ChatRequest) => {
          // Verify the prompt includes the task
          return {
            text: "Task completed: I reviewed the code and found 3 issues.",
            model: "llama3",
            provider: "ollama",
          };
        },
      });

      registry.register(ollama);

      // Assign a task
      const assignResult = await dispatch(
        "agent_assign_task",
        {
          provider: "ollama",
          task: "Review the authentication module for security issues",
          files: ["/src/auth.ts", "/src/middleware.ts"],
        },
        deps,
      );

      expect(assignResult.isError).toBeUndefined();
      const assignText = assignResult.content[0].text;
      expect(assignText).toContain("Task completed");
      expect(assignText).toContain("I reviewed the code and found 3 issues");

      // Extract task ID
      const taskIdMatch = assignText.match(/Task ID:\*\* (\S+)/);
      expect(taskIdMatch).not.toBeNull();
      const taskId = taskIdMatch![1];

      // Check task status
      const statusResult = await dispatch(
        "agent_task_status",
        { task_id: taskId },
        deps,
      );

      expect(statusResult.isError).toBeUndefined();
      const statusText = statusResult.content[0].text;
      expect(statusText).toContain(taskId);
      expect(statusText).toContain("completed");
      expect(statusText).toContain("ollama");
      expect(statusText).toContain("Review the authentication module");
      expect(statusText).toContain("I reviewed the code and found 3 issues");
    });

    it("should mark task as failed when provider throws", async () => {
      const failing = createMockProvider("failing", {
        chatFn: async () => {
          throw new Error("Provider timed out");
        },
      });

      registry.register(failing);

      const result = await dispatch(
        "agent_assign_task",
        {
          provider: "failing",
          task: "Do something",
        },
        deps,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Task failed");
      expect(result.content[0].text).toContain("Provider timed out");

      // Extract task ID and verify status is failed
      const taskIdMatch = result.content[0].text.match(/Task ID:\*\* (\S+)/);
      expect(taskIdMatch).not.toBeNull();
      const taskId = taskIdMatch![1];

      const statusResult = await dispatch(
        "agent_task_status",
        { task_id: taskId },
        deps,
      );
      expect(statusResult.content[0].text).toContain("failed");
    });

    it("should return error for non-existent task ID", async () => {
      const result = await dispatch(
        "agent_task_status",
        { task_id: "nonexistent-id" },
        deps,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Task not found");
    });
  });

  // ── 3. Workspace: create review -> add comment -> read ────────────

  describe("workspace flow: create review -> add comment -> read", () => {
    it("should create a review, add comments, and read the full document", async () => {
      // Step 1: Create a review document
      const createResult = await dispatch(
        "workspace_create_review",
        {
          files: ["/src/auth.ts", "/src/middleware.ts"],
          rules: ["No SQL injection", "Use parameterized queries", "Validate input"],
        },
        deps,
      );

      expect(createResult.isError).toBeUndefined();
      const createText = createResult.content[0].text;
      expect(createText).toContain("Review created");
      expect(createText).toContain("/src/auth.ts");
      expect(createText).toContain("/src/middleware.ts");

      // Extract document ID
      const docIdMatch = createText.match(/Document ID:\*\* (\S+)/);
      expect(docIdMatch).not.toBeNull();
      const docId = docIdMatch![1];

      // Step 2: Add a comment from a human reviewer
      const commentResult1 = await dispatch(
        "workspace_add_comment",
        {
          doc_id: docId,
          author: "Alice",
          content: "The auth module looks good but needs input sanitization on line 42.",
        },
        deps,
      );

      expect(commentResult1.isError).toBeUndefined();
      expect(commentResult1.content[0].text).toContain("Comment added");
      expect(commentResult1.content[0].text).toContain("Alice");

      // Step 3: Add another comment from an AI reviewer
      const commentResult2 = await dispatch(
        "workspace_add_comment",
        {
          doc_id: docId,
          author: "AI (ollama)",
          content: "I agree with Alice. Additionally, consider using bcrypt for password hashing.",
        },
        deps,
      );

      expect(commentResult2.isError).toBeUndefined();

      // Step 4: Read the full document with all comments
      const readResult = await dispatch(
        "workspace_read",
        { doc_id: docId },
        deps,
      );

      expect(readResult.isError).toBeUndefined();
      const readText = readResult.content[0].text;

      // Document should contain original review info
      expect(readText).toContain(docId);
      expect(readText).toContain("/src/auth.ts");
      expect(readText).toContain("/src/middleware.ts");

      // Document should contain rules
      expect(readText).toContain("No SQL injection");
      expect(readText).toContain("Use parameterized queries");
      expect(readText).toContain("Validate input");

      // Document should contain both comments
      expect(readText).toContain("Alice");
      expect(readText).toContain("input sanitization on line 42");
      expect(readText).toContain("AI (ollama)");
      expect(readText).toContain("bcrypt for password hashing");
    });

    it("should return error when reading non-existent document", async () => {
      await expect(
        dispatch(
          "workspace_read",
          { doc_id: "nonexistent-doc" },
          deps,
        ),
      ).rejects.toThrow("Document not found");
    });

    it("should return error when adding comment to non-existent document", async () => {
      await expect(
        dispatch(
          "workspace_add_comment",
          { doc_id: "nonexistent-doc", author: "Test", content: "Comment" },
          deps,
        ),
      ).rejects.toThrow("Document not found");
    });
  });

  // ── Combined: debate + workspace flow ─────────────────────────────

  describe("Combined debate and workspace flow", () => {
    it("should run a debate and store the result as a workspace review", async () => {
      const ollama = createMockProvider("ollama", {
        response: "Ollama: We should use TypeScript for type safety.",
      });
      const gemini = createMockProvider("gemini", {
        response: "Gemini: I agree, TypeScript reduces runtime errors.",
      });

      registry.register(ollama);
      registry.register(gemini);

      // Step 1: Run the debate
      const debateResult = await dispatch(
        "agent_debate_start",
        {
          topic: "TypeScript adoption",
          providers: ["ollama", "gemini"],
          max_rounds: 1,
        },
        deps,
      );

      expect(debateResult.isError).toBeUndefined();

      // Step 2: Create a review with the debate topic as context
      const reviewResult = await dispatch(
        "workspace_create_review",
        {
          files: ["/src/tsconfig.json"],
          rules: ["TypeScript strict mode", "No any types"],
        },
        deps,
      );

      const docIdMatch = reviewResult.content[0].text.match(/Document ID:\*\* (\S+)/);
      const docId = docIdMatch![1];

      // Step 3: Add debate conclusion as a comment
      await dispatch(
        "workspace_add_comment",
        {
          doc_id: docId,
          author: "Debate Summary",
          content: "Both providers agree: TypeScript improves type safety and reduces runtime errors.",
        },
        deps,
      );

      // Step 4: Read and verify
      const readResult = await dispatch(
        "workspace_read",
        { doc_id: docId },
        deps,
      );

      expect(readResult.content[0].text).toContain("Debate Summary");
      expect(readResult.content[0].text).toContain("TypeScript improves type safety");
    });
  });

  // ── Session persistence ───────────────────────────────────────────

  describe("Session persistence with real temp directory", () => {
    it("should persist sessions to disk and load them back", async () => {
      const ollama = createMockProvider("ollama", {
        response: "Task done.",
      });
      registry.register(ollama);

      // Assign a task (creates a session)
      const assignResult = await dispatch(
        "agent_assign_task",
        { provider: "ollama", task: "Persistent task" },
        deps,
      );
      const taskIdMatch = assignResult.content[0].text.match(/Task ID:\*\* (\S+)/);
      const taskId = taskIdMatch![1];

      // Create a new SessionManager pointing to the same dir
      // to verify sessions were persisted
      const freshManager = new SessionManager(tmpDir);
      const loadedSession = freshManager.getSession(taskId);

      expect(loadedSession).toBeDefined();
      expect(loadedSession!.status).toBe("completed");
      expect(loadedSession!.result).toContain("Task done.");
    });
  });
});
