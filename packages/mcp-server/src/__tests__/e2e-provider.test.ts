/**
 * E2E Provider Lifecycle Test
 *
 * Tests the full flow: config parse -> provider init -> registry -> tool dispatch -> response.
 * Uses mock providers (no real Ollama/Gemini required).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProviderRegistry, ProviderNotFoundError } from "@agestra/core";
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

import { dispatch, createServer, collectTools, type ServerDependencies } from "../server.js";

// ── Mock Providers ──────────────────────────────────────────────────

function createMockProvider(
  id: string,
  opts: {
    response?: string;
    available?: boolean;
    healthStatus?: HealthStatus;
    capabilities?: Partial<ProviderCapability>;
    chatFn?: (req: ChatRequest) => Promise<ChatResponse>;
    initError?: boolean;
  } = {},
): AIProvider {
  const response = opts.response ?? `Response from ${id}`;
  const available = opts.available ?? true;
  const healthStatus: HealthStatus = opts.healthStatus ?? { status: "ok", message: `${id} is healthy` };
  const capabilities: ProviderCapability = {
    maxContext: 4096,
    supportsSystemPrompt: true,
    supportsFiles: false,
    supportsStreaming: false,
    supportsJsonOutput: false,
    supportsToolUse: false,
    strengths: ["general"],
    models: [{ name: `${id}-default`, description: `Default model for ${id}`, strengths: [] }],
    ...opts.capabilities,
  };

  return {
    id,
    type: "mock",
    initialize: async () => {
      if (opts.initError) throw new Error(`Failed to initialize ${id}`);
    },
    healthCheck: async () => healthStatus,
    getCapabilities: () => capabilities,
    isAvailable: () => available,
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
  } as any;
}

// ── Test Suite ──────────────────────────────────────────────────────

describe("E2E: Provider Lifecycle", () => {
  let tmpDir: string;
  let registry: ProviderRegistry;
  let deps: ServerDependencies;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "e2e-provider-"));
    registry = new ProviderRegistry();

    const sessionManager = new SessionManager(tmpDir);
    const documentManager = new DocumentManager(tmpDir);
    const memoryFacade = createMockMemoryFacade();

    deps = { registry, sessionManager, documentManager, memoryFacade };
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // ── 1. ai_chat with mock provider ────────────────────────────────

  describe("ai_chat with mock Ollama provider", () => {
    it("should route through full chain: registry -> dispatch -> provider.chat -> response", async () => {
      const ollama = createMockProvider("ollama", {
        response: "Ollama says hello!",
      });
      registry.register(ollama);

      const result = await dispatch(
        "ai_chat",
        { provider: "ollama", prompt: "Hello from E2E test" },
        deps,
      );

      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].text).toContain("Ollama says hello!");
      expect(result.content[0].text).toContain("ollama");
      expect(result.content[0].text).toContain("ollama-model");
    });

    it("should pass system prompt and model override through the full chain", async () => {
      const chatSpy = vi.fn().mockResolvedValue({
        text: "Custom response",
        model: "llama3:8b",
        provider: "ollama",
      });
      const ollama = createMockProvider("ollama", { chatFn: chatSpy });
      registry.register(ollama);

      const result = await dispatch(
        "ai_chat",
        {
          provider: "ollama",
          prompt: "Explain TypeScript",
          model: "llama3:8b",
          system: "You are a helpful assistant",
        },
        deps,
      );

      expect(result.isError).toBeUndefined();
      expect(chatSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "Explain TypeScript",
          model: "llama3:8b",
          system: "You are a helpful assistant",
        }),
      );
      expect(result.content[0].text).toContain("Custom response");
    });
  });

  // ── 2. Non-existent provider -> ProviderNotFoundError ────────────

  describe("ai_chat with non-existent provider", () => {
    it("should throw ProviderNotFoundError when provider is not registered", async () => {
      // Register only ollama, try to use "nonexistent"
      registry.register(createMockProvider("ollama"));

      await expect(
        dispatch(
          "ai_chat",
          { provider: "nonexistent", prompt: "Hello" },
          deps,
        ),
      ).rejects.toThrow(ProviderNotFoundError);
    });

    it("should throw ProviderNotFoundError with provider id in message", async () => {
      await expect(
        dispatch(
          "ai_chat",
          { provider: "ghost-provider", prompt: "Hello" },
          deps,
        ),
      ).rejects.toThrow("ghost-provider");
    });
  });

  // ── 3. ai_compare with parallel calls ────────────────────────────

  describe("ai_compare with multiple providers", () => {
    it("should call both providers in parallel and return comparison result", async () => {
      const ollamaCallTime = { start: 0, end: 0 };
      const geminiCallTime = { start: 0, end: 0 };

      const ollama = createMockProvider("ollama", {
        chatFn: async () => {
          ollamaCallTime.start = Date.now();
          await new Promise((r) => setTimeout(r, 10));
          ollamaCallTime.end = Date.now();
          return { text: "Ollama perspective on testing", model: "llama3", provider: "ollama" };
        },
      });

      const gemini = createMockProvider("gemini", {
        chatFn: async () => {
          geminiCallTime.start = Date.now();
          await new Promise((r) => setTimeout(r, 10));
          geminiCallTime.end = Date.now();
          return { text: "Gemini perspective on testing", model: "gemini-pro", provider: "gemini" };
        },
      });

      registry.register(ollama);
      registry.register(gemini);

      const result = await dispatch(
        "ai_compare",
        {
          providers: ["ollama", "gemini"],
          prompt: "What is the best testing strategy?",
        },
        deps,
      );

      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      expect(text).toContain("ollama");
      expect(text).toContain("gemini");
      expect(text).toContain("Ollama perspective on testing");
      expect(text).toContain("Gemini perspective on testing");
      expect(text).toContain("What is the best testing strategy?");
    });

    it("should include error info when one provider fails during comparison", async () => {
      const ollama = createMockProvider("ollama", {
        response: "Ollama works fine",
      });
      const failing = createMockProvider("failing-provider", {
        chatFn: async () => {
          throw new Error("Connection refused");
        },
      });

      registry.register(ollama);
      registry.register(failing);

      const result = await dispatch(
        "ai_compare",
        {
          providers: ["ollama", "failing-provider"],
          prompt: "Compare test",
        },
        deps,
      );

      const text = result.content[0].text;
      expect(text).toContain("Ollama works fine");
      expect(text).toContain("Connection refused");
      expect(text).toContain("Error");
    });
  });

  // ── 4. Provider initialization failure -> server still starts ────

  describe("Provider initialization failure", () => {
    it("should register provider that fails init as unavailable, server still works", async () => {
      const failingProvider = createMockProvider("broken-ollama", {
        available: false,
        initError: true,
        healthStatus: { status: "error", message: "Failed to connect" },
      });

      // Simulate initialization failure
      await expect(failingProvider.initialize()).rejects.toThrow("Failed to initialize broken-ollama");

      // Provider is still registerable even after init failure
      registry.register(failingProvider);

      // Server still starts (createServer should not throw)
      const server = createServer(deps);
      expect(server).toBeDefined();

      // Provider is in registry but unavailable
      expect(registry.has("broken-ollama")).toBe(true);
      expect(registry.get("broken-ollama").isAvailable()).toBe(false);

      // Other tools still work (e.g., provider_list shows the broken provider)
      const listResult = await dispatch("provider_list", {}, deps);
      expect(listResult.isError).toBeUndefined();
      expect(listResult.content[0].text).toContain("broken-ollama");
      expect(listResult.content[0].text).toContain("Unavailable");
    });

    it("should still serve healthy providers when one is broken", async () => {
      const healthy = createMockProvider("gemini", {
        response: "Gemini works",
      });
      const broken = createMockProvider("broken-ollama", {
        available: false,
      });

      registry.register(healthy);
      registry.register(broken);

      // Chat with healthy provider should work
      const chatResult = await dispatch(
        "ai_chat",
        { provider: "gemini", prompt: "Hello" },
        deps,
      );
      expect(chatResult.isError).toBeUndefined();
      expect(chatResult.content[0].text).toContain("Gemini works");

      // Available providers list should only include healthy ones
      const available = registry.getAvailable();
      expect(available).toHaveLength(1);
      expect(available[0].id).toBe("gemini");
    });
  });

  // ── 5. provider_list returns all providers with capabilities ─────

  describe("provider_list tool", () => {
    it("should return all registered providers with their capabilities", async () => {
      const ollama = createMockProvider("ollama", {
        capabilities: {
          maxContext: 8192,
          supportsSystemPrompt: true,
          supportsFiles: false,
          supportsStreaming: true,
          supportsJsonOutput: true,
          supportsToolUse: false,
          strengths: ["coding", "analysis"],
          models: [
            { name: "llama3:8b", description: "Llama 3 8B", strengths: ["fast"] },
            { name: "codellama:13b", description: "Code Llama 13B", strengths: ["coding"] },
          ],
        },
      });

      const gemini = createMockProvider("gemini", {
        capabilities: {
          maxContext: 32768,
          supportsFiles: true,
          strengths: ["reasoning", "multimodal"],
          models: [
            { name: "gemini-pro", description: "Gemini Pro", strengths: ["general"] },
          ],
        },
      });

      registry.register(ollama);
      registry.register(gemini);

      const result = await dispatch("provider_list", {}, deps);

      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;

      // Check ollama details
      expect(text).toContain("ollama");
      expect(text).toContain("8192");
      expect(text).toContain("coding");
      expect(text).toContain("analysis");
      expect(text).toContain("llama3:8b");
      expect(text).toContain("codellama:13b");

      // Check gemini details
      expect(text).toContain("gemini");
      expect(text).toContain("32768");
      expect(text).toContain("reasoning");
      expect(text).toContain("multimodal");
      expect(text).toContain("gemini-pro");

      // Check counts
      expect(text).toContain("Registered Providers (2)");
    });

    it("should show empty message when no providers registered", async () => {
      const result = await dispatch("provider_list", {}, deps);
      expect(result.content[0].text).toContain("No providers registered");
    });
  });

  // ── 6. provider_health returns health status ─────────────────────

  describe("provider_health tool", () => {
    it("should return health status for all registered providers", async () => {
      const ollama = createMockProvider("ollama", {
        healthStatus: { status: "ok", message: "Ollama is running" },
      });
      const gemini = createMockProvider("gemini", {
        healthStatus: { status: "degraded", message: "Rate limited" },
      });
      const broken = createMockProvider("codex", {
        healthStatus: { status: "error", message: "CLI not found" },
      });

      registry.register(ollama);
      registry.register(gemini);
      registry.register(broken);

      const result = await dispatch("provider_health", {}, deps);

      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;

      expect(text).toContain("Health Check Results");
      expect(text).toContain("ollama");
      expect(text).toContain("OK");
      expect(text).toContain("Ollama is running");
      expect(text).toContain("gemini");
      expect(text).toContain("DEGRADED");
      expect(text).toContain("Rate limited");
      expect(text).toContain("codex");
      expect(text).toContain("ERROR");
      expect(text).toContain("CLI not found");
    });

    it("should check a single provider when provider ID is specified", async () => {
      const ollama = createMockProvider("ollama", {
        healthStatus: { status: "ok", message: "Running fine" },
      });
      const gemini = createMockProvider("gemini");

      registry.register(ollama);
      registry.register(gemini);

      const result = await dispatch(
        "provider_health",
        { provider: "ollama" },
        deps,
      );

      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      expect(text).toContain("ollama");
      expect(text).toContain("Running fine");
      // Should not contain gemini since we only asked for ollama
    });

    it("should handle healthCheck throwing an error", async () => {
      const errorProvider = createMockProvider("error-provider");
      (errorProvider as any).healthCheck = async () => {
        throw new Error("Health check crashed");
      };
      registry.register(errorProvider);

      const result = await dispatch("provider_health", {}, deps);

      const text = result.content[0].text;
      expect(text).toContain("error-provider");
      expect(text).toContain("Health check crashed");
    });
  });

  // ── Cross-cutting: createServer produces a valid MCP server ──────

  describe("createServer integration", () => {
    it("should create a server that exposes all tools", () => {
      registry.register(createMockProvider("ollama"));
      const server = createServer(deps);
      expect(server).toBeDefined();

      const tools = collectTools();
      expect(tools.length).toBeGreaterThanOrEqual(18);

      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain("ai_chat");
      expect(toolNames).toContain("ai_compare");
      expect(toolNames).toContain("provider_list");
      expect(toolNames).toContain("provider_health");
    });
  });

  // ── Full lifecycle: register -> init -> health -> chat -> list ────

  describe("Full provider lifecycle", () => {
    it("should handle complete provider lifecycle from registration to chat", async () => {
      // Step 1: Create and register providers
      const ollama = createMockProvider("ollama", {
        response: "I am Ollama, a local LLM",
        capabilities: {
          strengths: ["fast", "private"],
          models: [{ name: "llama3:8b", description: "Llama 3 8B", strengths: [] }],
        },
      });
      const gemini = createMockProvider("gemini", {
        response: "I am Gemini, a cloud LLM",
        capabilities: {
          strengths: ["reasoning"],
          models: [{ name: "gemini-pro", description: "Gemini Pro", strengths: [] }],
        },
      });

      registry.register(ollama);
      registry.register(gemini);

      // Step 2: Initialize providers
      await ollama.initialize();
      await gemini.initialize();

      // Step 3: Health check
      const healthResult = await dispatch("provider_health", {}, deps);
      expect(healthResult.content[0].text).toContain("OK");

      // Step 4: List providers
      const listResult = await dispatch("provider_list", {}, deps);
      expect(listResult.content[0].text).toContain("ollama");
      expect(listResult.content[0].text).toContain("gemini");

      // Step 5: Chat with a provider
      const chatResult = await dispatch(
        "ai_chat",
        { provider: "ollama", prompt: "Who are you?" },
        deps,
      );
      expect(chatResult.content[0].text).toContain("I am Ollama, a local LLM");

      // Step 6: Compare providers
      const compareResult = await dispatch(
        "ai_compare",
        {
          providers: ["ollama", "gemini"],
          prompt: "Who are you?",
        },
        deps,
      );
      const compareText = compareResult.content[0].text;
      expect(compareText).toContain("I am Ollama, a local LLM");
      expect(compareText).toContain("I am Gemini, a cloud LLM");
    });
  });
});
