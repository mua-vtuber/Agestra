#!/usr/bin/env node

// @agestra/mcp-server — entry point & barrel export

import { readFileSync } from "fs";
import { join } from "path";
import type { AIProvider } from "@agestra/core";
import {
  parseProviderConfig,
  ProviderRegistry,
  JobManager,
  TraceWriter,
} from "@agestra/core";
import { OllamaProvider } from "@agestra/provider-ollama";
import { GeminiProvider } from "@agestra/provider-gemini";
import { CodexProvider } from "@agestra/provider-codex";
import { SessionManager } from "@agestra/agents";
import { DocumentManager } from "@agestra/workspace";
import { MemoryFacade } from "@agestra/memory";

import { createServer, connectStdio } from "./server.js";
import {
  detectProviders,
  registerDetectedProviders,
} from "./tools/provider-detector.js";

// ── Re-exports for library usage ──────────────────────────────

export {
  createServer,
  connectStdio,
  collectTools,
  dispatch,
  truncateResponse,
  type ServerDependencies,
} from "./server.js";

// ── Provider factories ────────────────────────────────────────

const factories: Record<string, (pc: { id: string; config?: Record<string, unknown> }) => AIProvider> = {
  ollama: (pc) =>
    new OllamaProvider({
      id: pc.id,
      host: (pc.config?.host as string) || "http://localhost:11434",
    }),
  "gemini-cli": (pc) =>
    new GeminiProvider({
      id: pc.id,
      timeout: pc.config?.timeout as number | undefined,
    }),
  "codex-cli": (pc) =>
    new CodexProvider({
      id: pc.id,
      timeout: pc.config?.timeout as number | undefined,
    }),
};

// ── Auto-detect ──────────────────────────────────────────────

export async function autoDetectIfNeeded(
  registry: InstanceType<typeof ProviderRegistry>,
  baseDir: string,
  log: (msg: string) => void,
): Promise<{ detected: number }> {
  if (registry.getAll().length > 0) {
    log("Providers already registered, skipping auto-detect.");
    return { detected: 0 };
  }

  log("No providers found — running auto-detect...");

  try {
    const { results, providers } = await detectProviders();
    const available = results.filter((r) => r.available);

    if (available.length === 0) {
      log("Auto-detect found no available providers.");
      return { detected: 0 };
    }

    // Register into live registry
    registerDetectedProviders(providers, registry);

    log(`Auto-detected ${available.length} provider(s): ${available.map((r) => r.id).join(", ")}`);
    return { detected: available.length };
  } catch (err) {
    log(`Auto-detect failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    return { detected: 0 };
  }
}

// ── Main ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Log to stderr (MCP uses stdout for protocol messages)
  const log = (msg: string) => process.stderr.write(`[mcp-server] ${msg}\n`);

  // 1. Load config
  const configPath = join(process.cwd(), "providers.config.json");
  let rawConfig: unknown;
  try {
    const configText = readFileSync(configPath, "utf-8");
    rawConfig = JSON.parse(configText);
  } catch (err) {
    log(`Warning: Could not load ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
    log("Starting with empty provider registry.");
    rawConfig = null;
  }

  // 2. Parse config and create providers
  const registry = new ProviderRegistry();

  if (rawConfig) {
    const config = parseProviderConfig(rawConfig);

    for (const pc of config.enabledProviders) {
      const factory = factories[pc.type];
      if (!factory) {
        log(`Unknown provider type: ${pc.type} (id: ${pc.id}), skipping`);
        continue;
      }

      try {
        const provider = factory(pc);
        await provider.initialize();
        registry.register(provider);
        log(`Registered provider: ${pc.id} (${pc.type})`);
      } catch (err) {
        log(
          `Failed to initialize provider ${pc.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // 2b. Auto-detect if registry is empty
  const baseDir = process.cwd();
  await autoDetectIfNeeded(registry, baseDir, log);

  // 3. Create supporting services
  const sessionManager = new SessionManager(join(baseDir, ".agestra/sessions"));
  const documentManager = new DocumentManager(join(baseDir, ".agestra/workspace"));
  const memoryFacade = new MemoryFacade({ dbPath: join(baseDir, ".agestra/memory.db") });
  try {
    await memoryFacade.initialize();
  } catch (err) {
    log(`Memory system unavailable: ${err instanceof Error ? err.message : String(err)}`);
    log("Memory tools will be non-functional. Other tools work normally.");
  }
  const jobManager = new JobManager(baseDir);
  const traceWriter = new TraceWriter(baseDir);
  traceWriter.cleanup(30); // Remove trace files older than 30 days

  // 4. Create and connect MCP server
  const server = createServer({
    registry,
    sessionManager,
    documentManager,
    memoryFacade,
    jobManager,
    traceWriter,
  });

  log(`Starting MCP server with ${registry.getAll().length} provider(s)...`);
  await connectStdio(server);
  log("MCP server connected via stdio.");
}

// Run when executed directly (not imported)
const isDirectRun =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("/mcp-server/dist/index.js") ||
   process.argv[1].endsWith("/mcp-server/src/index.ts") ||
   process.argv[1].endsWith("/dist/bundle.js"));

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`[mcp-server] Fatal: ${err}\n`);
    process.exit(1);
  });
}
