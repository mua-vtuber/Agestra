# Agestra

**Agent + Orchestra** — An MCP server that orchestrates multiple AI providers through Claude Code.

[English](README.md) | [한국어](README.ko.md)

Agestra connects Ollama (local), Gemini CLI, and Codex CLI to Claude Code as pluggable providers, enabling multi-agent debates, parallel task dispatch, cross-validation, and a persistent GraphRAG memory system — all through 31 MCP tools.

## Quick Start

```bash
git clone https://github.com/mua-vtuber/agestra.git
cd agestra
npm install
npm run build
```

Register with Claude Code:

```bash
claude mcp add agestra node $(pwd)/packages/mcp-server/dist/index.js
```

Then ask Claude to run `agestra_setup`. It auto-detects providers, generates config, and sets up `CLAUDE.md` + hooks in one call.

---

## Architecture

Turborepo monorepo with 8 packages:

| Package | Description |
|---------|-------------|
| `@agestra/core` | `AIProvider` interface, registry, config loader, CLI runner, atomic writes, job queue |
| `@agestra/provider-ollama` | Ollama HTTP adapter with model detection |
| `@agestra/provider-gemini` | Google Gemini CLI adapter |
| `@agestra/provider-codex` | OpenAI Codex CLI adapter |
| `@agestra/agents` | Debate engine, task dispatcher, cross-validator, session manager |
| `@agestra/workspace` | Document manager for code review workflows |
| `@agestra/memory` | GraphRAG — FTS5 + vector + knowledge graph hybrid search, dead-end tracking |
| `@agestra/mcp-server` | MCP protocol layer, 31 tools, dispatch, config generation |

### Design Principles

- **Provider abstraction** — All backends implement `AIProvider` (`chat`, `healthCheck`, `getCapabilities`). New providers require no existing code changes.
- **Config-driven** — `providers.config.json` declares enabled providers. The registry loads and exposes them at runtime.
- **Modular dispatch** — Each tool category is an independent module with `getTools()` + `handleTool()`. The server collects and dispatches dynamically.
- **Atomic writes** — All file operations use write-to-temp-then-rename to prevent corruption.
- **Dead-end tracking** — Failed approaches are recorded in GraphRAG and injected into future prompts.
- **Dynamic capability judgment** — Ollama models are assessed by parameter count (estimated from file size). Cloud providers are always agent-tier.

---

## Tools (31)

### AI Chat (3)

| Tool | Description |
|------|-------------|
| `ai_chat` | Chat with a specific provider |
| `ai_analyze_files` | Read files from disk and send contents with a question to a provider |
| `ai_compare` | Send the same prompt to multiple providers, compare responses |

### Agent Orchestration (9)

| Tool | Description |
|------|-------------|
| `agent_debate_start` | Start a multi-provider debate (non-blocking, optional quality loop + validator) |
| `agent_debate_status` | Check debate status and transcript |
| `agent_debate_create` | Create a turn-based debate session (returns debate ID) |
| `agent_debate_turn` | Execute one provider's turn; optionally inject Claude's commentary |
| `agent_debate_conclude` | End a debate and generate final transcript |
| `agent_assign_task` | Delegate a task to a specific provider |
| `agent_task_status` | Check task completion and result |
| `agent_dispatch` | Distribute tasks across providers in parallel (dependency ordering) |
| `agent_cross_validate` | Cross-validate outputs (agent-tier validators only) |

### Workspace (4)

| Tool | Description |
|------|-------------|
| `workspace_create_review` | Create a code review document with files and rules |
| `workspace_request_review` | Request a provider to review a document |
| `workspace_add_comment` | Add a comment to a review |
| `workspace_read` | Read review contents |

### Provider Management (2)

| Tool | Description |
|------|-------------|
| `provider_list` | List providers with status and capabilities |
| `provider_health` | Health check one or all providers |

### Ollama (2)

| Tool | Description |
|------|-------------|
| `ollama_models` | List installed models with sizes |
| `ollama_pull` | Download a model |

### Memory (6)

| Tool | Description |
|------|-------------|
| `memory_search` | Hybrid retrieval (FTS5 + vector + graph) |
| `memory_index` | Index files/directories into memory |
| `memory_store` | Store a knowledge node (fact, decision, dead_end, finding) |
| `memory_dead_ends` | Search previous failures to avoid repeating them |
| `memory_context` | Assemble relevant context within a token budget |
| `memory_add_edge` | Create relationship edges between knowledge nodes |

### Jobs (2)

| Tool | Description |
|------|-------------|
| `cli_job_submit` | Submit a long-running CLI task to background |
| `cli_job_status` | Check job status and output |

### Setup (3)

| Tool | Description |
|------|-------------|
| `agestra_setup` | One-stop: detect providers, health check, generate CLAUDE.md + hooks |
| `agestra_generate_config` | Regenerate CLAUDE.md section and hooks (dry_run for preview) |
| `agestra_remove` | Remove all agestra-generated config (CLAUDE.md section, hooks, providers.config.json) |

---

## Configuration

### MCP Registration

From your **terminal** (not inside Claude Code):

```bash
claude mcp add agestra node $(pwd)/packages/mcp-server/dist/index.js
```

Or edit `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "agestra": {
      "command": "node",
      "args": ["<PROJECT_ROOT>/packages/mcp-server/dist/index.js"]
    }
  }
}
```

### providers.config.json

Auto-generated by `agestra_setup`. Supports manual editing.

| Field | Description |
|-------|-------------|
| `defaultProvider` | Provider ID when none specified |
| `providers[].id` | Unique identifier |
| `providers[].type` | `ollama`, `gemini-cli`, or `codex-cli` |
| `providers[].enabled` | Load at startup |
| `providers[].executionPolicy` | `read-only`, `workspace-write`, or `full-auto` |
| `providers[].config` | Type-specific settings (host, timeout, etc.) |

Re-running `agestra_setup` merges results: `enabled` flags update, user settings are preserved.

### Generated Files

| File | Purpose |
|------|---------|
| `providers.config.json` | Provider declarations (auto-detected) |
| `CLAUDE.md` | Usage guidelines, capability tiers, workflows, completion checklist |
| `.claude/settings.local.json` | Hooks — session start, commit review, agestra suggestions, completion verification |

Sections use version markers (`<!-- [agestra:v4.0.0] BEGIN/END -->`) for safe in-place updates.

### Runtime Data

Stored under `.agestra/` (gitignored):

| Path | Purpose |
|------|---------|
| `.agestra/sessions/` | Debate and task session state |
| `.agestra/workspace/` | Code review documents |
| `.agestra/memory.db` | GraphRAG SQLite database |
| `.agestra/.jobs/` | Background job queue |

---

## Development

```bash
npm run build      # Build all packages (Turborepo)
npm test           # Run all tests (Vitest)
npm run dev        # Watch mode
npm run lint       # Lint (ESLint)
npm run clean      # Remove dist/
```

### Project Structure

```
agestra/
├── packages/
│   ├── core/               # AIProvider interface, registry, atomic writes, job queue
│   ├── provider-ollama/    # Ollama HTTP adapter
│   ├── provider-gemini/    # Gemini CLI adapter
│   ├── provider-codex/     # Codex CLI adapter
│   ├── agents/             # Debate engine, dispatcher, cross-validator, sessions
│   ├── workspace/          # Code review document manager
│   ├── memory/             # GraphRAG: hybrid search, dead-end tracking, context assembly
│   └── mcp-server/         # MCP server, 31 tools, dispatch, config generation
├── providers.config.json   # Provider configuration
├── package.json            # Workspace root
└── turbo.json              # Turborepo pipeline
```

### Adding a Provider

1. Create `packages/provider-<name>/` implementing `AIProvider`.
2. Add a factory in `packages/mcp-server/src/index.ts`.
3. Add a block to `providers.config.json`.
4. `npm run build && npm test`

---

## Requirements

| Dependency | Required | Notes |
|------------|----------|-------|
| Node.js 18+ | Yes | Runtime |
| npm | Yes | Workspaces |
| [Ollama](https://ollama.com/) | No | For local LLM provider |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | No | For Gemini provider |
| [Codex CLI](https://github.com/openai/codex) | No | For Codex provider |

At least one provider must be installed for the server to be useful.

---

## License

MIT
