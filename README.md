# Agestra

[![npm version](https://img.shields.io/npm/v/agestra.svg)](https://www.npmjs.com/package/agestra)
[![license](https://img.shields.io/npm/l/agestra.svg)](LICENSE)

**Agent + Orchestra** — A Claude Code plugin that orchestrates multiple AI providers.

[English](README.md) | [한국어](README.ko.md)

Agestra connects Ollama (local), Gemini CLI, and Codex CLI to Claude Code as pluggable providers, enabling multi-agent debates, parallel task dispatch, cross-validation, and a persistent GraphRAG memory system — all through 43 MCP tools.

## Quick Start

In Claude Code, run:

```
/plugin marketplace add mua-vtuber/Agestra
/plugin install agestra@agestra
```

That's it. Agestra auto-detects available providers (Ollama, Gemini CLI, Codex CLI) on first use.

### Prerequisites

At least one AI provider must be installed:

| Provider | Install | Type |
|----------|---------|------|
| [Ollama](https://ollama.com/) | `curl -fsSL https://ollama.com/install.sh \| sh` | Local LLM |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `npm install -g @google/gemini-cli` | Cloud |
| [Codex CLI](https://github.com/openai/codex) | `npm install -g @openai/codex` | Cloud |

---

## Philosophy

**Multi-AI is for verification, not token savings.** The review, design exploration, and idea generation workflows are structured as validation processes — getting independent opinions from multiple AI providers to catch blind spots, not to parallelize for speed.

## Commands

| Command | Description |
|---------|-------------|
| `/agestra review [target]` | Review code quality, security, and integration completeness |
| `/agestra idea [topic]` | Discover improvements by comparing with similar projects |
| `/agestra design [subject]` | Explore architecture and design trade-offs before implementation |

Each command presents a choice: **Claude only**, **Compare** (multiple AIs side-by-side), **Debate** (structured multi-AI discussion), or **Other** (user-specified).

## Agents

| Agent | Model | Role |
|-------|-------|------|
| `agestra-reviewer` | Opus | Strict quality verifier — security, orphans, spec drift, test gaps |
| `agestra-designer` | Opus | Architecture explorer — Socratic questioning, trade-off analysis |
| `agestra-ideator` | Sonnet | Improvement discoverer — web research, competitive analysis |
| `agestra-moderator` | Sonnet | Debate facilitator — neutral, manages turns, judges consensus |

---

## Architecture

Turborepo monorepo with 8 packages:

| Package | Description |
|---------|-------------|
| `@agestra/core` | `AIProvider` interface, registry, config loader, CLI runner, atomic writes, job queue |
| `@agestra/provider-ollama` | Ollama HTTP adapter with model detection |
| `@agestra/provider-gemini` | Google Gemini CLI adapter |
| `@agestra/provider-codex` | OpenAI Codex CLI adapter |
| `@agestra/agents` | Debate engine, task dispatcher, cross-validator, task chain, auto-QA, file change tracker, session manager |
| `@agestra/workspace` | Document manager for code review workflows |
| `@agestra/memory` | GraphRAG — FTS5 + vector + knowledge graph hybrid search, dead-end tracking |
| `@agestra/mcp-server` | MCP protocol layer, 43 tools, dispatch |

### Design Principles

- **Provider abstraction** — All backends implement `AIProvider` (`chat`, `healthCheck`, `getCapabilities`). New providers require no existing code changes.
- **Zero-config** — Providers are auto-detected at startup. No manual configuration required.
- **Plugin-native** — Installed as a Claude Code plugin. Skills, hooks, and MCP server are bundled together.
- **Modular dispatch** — Each tool category is an independent module with `getTools()` + `handleTool()`. The server collects and dispatches dynamically.
- **Atomic writes** — All file operations use write-to-temp-then-rename to prevent corruption.
- **Dead-end tracking** — Failed approaches are recorded in GraphRAG and injected into future prompts.

---

## Tools (43)

### AI Chat (3)

| Tool | Description |
|------|-------------|
| `ai_chat` | Chat with a specific provider (use `"auto"` for quality-based routing) |
| `ai_analyze_files` | Read files from disk and send contents with a question to a provider |
| `ai_compare` | Send the same prompt to multiple providers, compare responses |

### Agent Orchestration (19)

| Tool | Description |
|------|-------------|
| `agent_debate_start` | Start a multi-provider debate (non-blocking, optional quality loop + validator) |
| `agent_debate_status` | Check debate status and transcript |
| `agent_debate_create` | Create a turn-based debate session (returns debate ID) |
| `agent_debate_turn` | Execute one provider's turn; supports `provider: "claude"` for Claude's independent participation |
| `agent_debate_conclude` | End a debate and generate final transcript |
| `agent_debate_review` | Send a document to multiple providers for independent review |
| `agent_assign_task` | Delegate a task to a specific provider |
| `agent_task_status` | Check task completion and result |
| `agent_dispatch` | Distribute tasks across providers in parallel (dependency ordering) |
| `agent_cross_validate` | Cross-validate outputs (agent-tier validators only) |
| `agent_task_chain_create` | Create a multi-step task chain with dependencies and checkpoints |
| `agent_task_chain_step` | Execute the next (or specified) step in a chain |
| `agent_task_chain_step_async` | Execute a step asynchronously (non-blocking) |
| `agent_task_chain_await` | Wait for an async step to complete |
| `agent_task_chain_status` | Check chain progress and step results |
| `agent_changes_review` | Review file changes from an isolated task |
| `agent_changes_accept` | Accept and merge changes from an isolated task |
| `agent_changes_reject` | Reject changes and clean up the isolated worktree |
| `session_list` | List all agent sessions with optional type/status filtering |

### Workspace (6)

| Tool | Description |
|------|-------------|
| `workspace_create_review` | Create a code review document with files and rules |
| `workspace_request_review` | Request a provider to review a document |
| `workspace_review_status` | Check review completion status |
| `workspace_add_comment` | Add a comment to a review |
| `workspace_read` | Read review contents |
| `workspace_list` | List all review documents in the workspace |

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

### Trace / Observability (3)

| Tool | Description |
|------|-------------|
| `trace_query` | Query trace records with filtering (provider, task, time range) |
| `trace_summary` | Get quality and performance stats per provider and task type |
| `trace_visualize` | Generate a Mermaid diagram of a traced operation's flow |

---

## Configuration

### providers.config.json (Optional)

Agestra auto-detects providers at startup. For manual control, create `providers.config.json` in the project root:

| Field | Description |
|-------|-------------|
| `defaultProvider` | Provider ID when none specified |
| `providers[].id` | Unique identifier |
| `providers[].type` | `ollama`, `gemini-cli`, or `codex-cli` |
| `providers[].enabled` | Load at startup |
| `providers[].config` | Type-specific settings (host, timeout, etc.) |

### Runtime Data

Stored under `.agestra/` (gitignored):

| Path | Purpose |
|------|---------|
| `.agestra/sessions/` | Debate and task session state |
| `.agestra/workspace/` | Code review documents |
| `.agestra/memory.db` | GraphRAG SQLite database |
| `.agestra/.jobs/` | Background job queue |
| `.agestra/traces/` | Provider trace JSONL (auto-pruned after 30 days) |

---

## Development

```bash
npm install        # Install dependencies
npm run build      # Build all packages (Turborepo)
npm test           # Run all tests (Vitest)
npm run bundle     # Build single-file plugin bundle (esbuild)
npm run dev        # Watch mode
npm run lint       # Lint (ESLint)
npm run clean      # Remove dist/
```

### Project Structure

```
agestra/
├── .claude-plugin/
│   ├── plugin.json          # Claude Code plugin manifest
│   └── marketplace.json     # Plugin marketplace metadata
├── commands/
│   ├── review.md            # /agestra review — quality verification
│   ├── idea.md              # /agestra idea — improvement discovery
│   └── design.md            # /agestra design — architecture exploration
├── agents/
│   ├── agestra-reviewer.md  # Strict quality verifier (Opus)
│   ├── agestra-designer.md  # Architecture explorer (Opus)
│   ├── agestra-ideator.md   # Improvement discoverer (Sonnet)
│   ├── agestra-moderator.md # Debate facilitator (Sonnet)
│   ├── agestra-qa.md        # QA verifier (Opus, no code writes)
│   └── agestra-team-lead.md # Task orchestrator (Sonnet, no code writes)
├── skills/
│   └── provider-guide.md    # Provider usage guidelines (skill)
├── hooks/
│   └── user-prompt-submit.md  # Tool recommendation hook
├── dist/
│   └── bundle.js            # Single-file MCP server bundle
├── scripts/
│   └── bundle.mjs           # esbuild bundle script
├── packages/
│   ├── core/                # AIProvider interface, registry
│   ├── provider-ollama/     # Ollama HTTP adapter
│   ├── provider-gemini/     # Gemini CLI adapter
│   ├── provider-codex/      # Codex CLI adapter
│   ├── agents/              # Debate engine, dispatcher, cross-validator
│   ├── workspace/           # Code review document manager
│   ├── memory/              # GraphRAG: hybrid search, dead-end tracking
│   └── mcp-server/          # MCP server, 43 tools, dispatch
├── package.json             # Workspace root
└── turbo.json               # Turborepo pipeline
```

### Adding a Provider

1. Create `packages/provider-<name>/` implementing `AIProvider`.
2. Add a factory in `packages/mcp-server/src/index.ts`.
3. `npm run build && npm test`

---

## Uninstall

In Claude Code:

```
/plugin uninstall agestra@agestra
```

No residual files in your project. Clean removal.

---

## License

[GPL-3.0](LICENSE)
