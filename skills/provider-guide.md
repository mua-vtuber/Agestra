---
name: provider-guide
description: >
  Use when routing tasks to AI providers, using any agestra MCP tool,
  reviewing code with multiple providers, starting debates, dispatching
  parallel tasks, cross-validating work, or managing CLI workers. Also
  triggers on mentions of Ollama, Gemini, or Codex providers.
---

## Available Providers

- **Ollama** — Local models. Detected at runtime via `ollama_models`.
- **Gemini** — Cloud agent. Full capability. Can run as autonomous CLI worker.
- **Codex** — Cloud agent. Full capability. Can run as autonomous CLI worker.

All providers are detected at runtime. Call `environment_check` for a full capability map, or `provider_list` / `provider_health` for provider availability.

## Environment Check

At session start or on demand, `environment_check` provides:
- CLI tool availability (codex, gemini, tmux)
- Ollama models with size-based tier classification
- Git worktree support
- Available modes: `claude_only`, `independent`, `debate`, `team`
- Whether autonomous CLI workers can be spawned

## Provider Capability Guidelines

### Ollama (Local)

Judge model capability by size (parameter count estimate):

| Model Size | Params (est.) | Suitable For |
|---|---|---|
| < 3 GB | ~1-3B | Simple — formatting, pattern matching, basic transforms |
| 3-8 GB | ~3-7B | Moderate — code review, simple analysis, summarization |
| 8-20 GB | ~7-14B | Complex — code generation, detailed analysis, multi-step reasoning |
| > 20 GB | ~14B+ | Advanced — architecture design, complex refactoring |

Models change frequently. Always call `ollama_models` before assigning tasks.

### Gemini / Codex (Cloud)

Full-capability agents. Use for:
- Complex tasks via `ai_chat` or `agent_assign_task` (text response)
- Autonomous coding via `cli_worker_spawn` (file modifications in worktree)
- Parallel work and as validators

## Work Modes

### Text Work (리뷰/설계/아이디어)

Three modes available via `/agestra review`, `/agestra design`, `/agestra idea`:

| Mode | Description | When to Use |
|------|-------------|-------------|
| **Claude only** | Specialist agent works alone | Quick analysis, no external AI needed |
| **각자 독립** | Each AI works independently → moderator aggregates | Want multiple perspectives, fast |
| **끝장토론** | Independent work + document review rounds until consensus | Need thorough, agreed-upon analysis |

### Implementation Work (실제 구현)

Two modes available via team-lead orchestration:

| Mode | Description | When to Use |
|------|-------------|-------------|
| **Claude만으로** | Claude directly implements with project/global agents | Simple tasks, 1-2 files |
| **다른 AI도 함께** | CLI workers do autonomous coding, Claude supervises | Complex tasks, 3+ files, parallelizable |

## CLI Workers

CLI workers spawn Codex or Gemini in `--full-auto` mode within isolated git worktrees.

| Tool | Purpose |
|------|---------|
| `cli_worker_spawn` | Spawn autonomous CLI worker with task manifest |
| `cli_worker_status` | Check worker FSM state, output, heartbeat |
| `cli_worker_collect` | Collect completed worker results (diff, output) |
| `cli_worker_stop` | Stop worker (SIGTERM → SIGKILL) + cleanup |

Worker lifecycle: SPAWNING → RUNNING → COLLECTING → COMPLETED (or FAILED/CANCELLED/TIMEOUT)

Use the `worker-manage` skill for user-friendly worker operations.

## Auto-Routing Guidelines

| Task Complexity | Route To |
|---|---|
| Simple (formatting, pattern matching) | Ollama local model preferred |
| Moderate (code review, summarization) | Ollama >= 3 GB or cloud |
| Complex implementation (multi-file, multi-step) | CLI worker (Codex/Gemini) |
| Complex analysis (architecture, refactoring) | Cloud providers (Gemini, Codex) via ai_chat |
| No providers available | Handle directly — do not suggest agestra tools |

## When to Suggest Agestra Tools

Suggest once, concisely, in the user's language. If declined or ignored, do not repeat.

Match by **semantic intent**, not literal keywords. These triggers apply in any language.

| Intent | Tool | When |
|---|---|---|
| Code review, review request | `/agestra review` or `workspace_create_review` | User asks to review code, PR, or implementation |
| Second opinion, other perspectives | `ai_compare` or `/agestra review` (각자 독립) | User wants multiple viewpoints on a decision |
| Validation, verification, cross-check | `agent_cross_validate` | User wants to confirm correctness of work output |
| Speed up, parallelize, split work | `agent_dispatch` or CLI workers | User wants faster execution or has independent tasks |
| Past experience, history, previous attempts | `memory_search` or `memory_dead_ends` | User asks about prior work or known issues |
| Remember this, save for later | `memory_store` | User wants to persist knowledge across sessions |
| Mention a provider by name (Gemini, Codex, Ollama) | `ai_chat` or `agent_assign_task` | Route directly to the named provider |
| Architecture review, design discussion | `/agestra design` | Structured multi-AI architecture exploration |
| Compare options, which is better | `ai_compare` | Side-by-side comparison from multiple providers |
| Large refactoring, many files to change | CLI workers or `agent_dispatch` | Split by file/module for parallel processing |
| About to commit, create PR, finalize work | `agent_cross_validate` | Pre-commit validation by other AI providers |
| Check worker status, manage workers | `worker-manage` skill | User asks about running workers |

### Commands and Agents

| Command | Specialist Agent | Purpose |
|---------|-----------------|---------|
| `/agestra review` | `agestra-reviewer` | Post-implementation quality verification |
| `/agestra idea` | `agestra-ideator` | Improvement discovery and competitive analysis |
| `/agestra design` | `agestra-designer` | Pre-implementation architecture exploration |

### Utility Skills

| Skill | Purpose |
|-------|---------|
| `trace` | View agent execution timeline, summary stats, and flow visualization |
| `build-fix` | Auto-diagnose and fix build/typecheck/lint errors one at a time |
| `cancel` | Gracefully stop running operations (including CLI workers) with state cleanup |
| `worker-manage` | List, check, collect, and stop CLI workers |

When "각자 독립" is selected, each AI works independently and `agestra-moderator` aggregates results.
When "끝장토론" is selected, `agestra-moderator` facilitates document review rounds after independent aggregation.

Commands and hook-triggered suggestions share the same 3-choice pattern (Claude only / 각자 독립 / 끝장토론). Commands are explicit entry points; hooks detect intent from natural language.

### Hook-Triggered Choice

When an `AGESTRA_SUGGESTION` marker appears from the UserPromptSubmit hook, present these choices:

1. **Claude only** — Claude Code handles it alone
2. **각자 독립** — Each AI works independently, moderator aggregates
3. **끝장토론** — Independent work + document review rounds until consensus
4. **Other** — User specifies the approach

Present choices in the user's language. If no providers are available, skip and proceed directly.

## Error Handling — 429 Rate Limit

1. **Detect** — Only known after receiving error response
2. **Deactivate** — Mark provider as unavailable for this session
3. **Notify** — Inform user which provider hit rate limit
4. **Redirect** — Immediately route remaining work to other available providers

Do NOT wait for rate limit reset.

## Memory System

- Failed approaches are automatically recorded as `dead_end` nodes.
- Call `memory_dead_ends` before starting work to avoid repeating failed strategies.
- Call `memory_store` to save findings for future sessions.

## Orchestration Pipeline

When team-lead orchestrates multi-AI work, the full pipeline is:

```
Phase 0: Clarity Gate (designer — ambiguity scoring, skip if request is clear)
Phase 1: Situation Assessment (team-lead — environment_check, providers, design doc)
Phase 2: Task Design (team-lead — work mode selection, decompose, route by AI capability)
Phase 3: Parallel Execution (team-lead — Claude + CLI workers + Ollama, monitor loop)
Phase 4: Result Inspection (team-lead — review diffs, check consistency, merge)
Phase 5: QA Cycle (qa — verify, classify failures → team-lead auto-fixes, max 5 cycles)
Phase 6: Quality Gate (reviewer — TRUST 5: Tested/Readable/Unified/Secured/Trackable)
Phase 7: Report
```

**Execution modes:**
- `supervised` (default): user approves task plan, decides on QA failures
- `autonomous` ("알아서 해줘"): auto-proceeds, escalates only on 3x same failure or Secured FAIL

**Work modes:**
- `Claude만으로`: Claude directly implements, no external workers
- `다른 AI도 함께`: CLI workers + Ollama for parallelized execution, Claude supervises

**QA Fix Loop — provider escalation:**
On failure, immediately assign to a DIFFERENT provider with full context (original task, previous AI, diagnosis, fix instruction, scope boundary). Never retry the same provider for the same failure.

## Completion Verification

Before marking work complete, verify all four:

1. **Spec compliance** — Built according to specifications/documentation
2. **System integration** — Connected to existing systems correctly
3. **Accessibility** — Accessible via UI/API to end users
4. **Tests pass** — With evidence (test output)
