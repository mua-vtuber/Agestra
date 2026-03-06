---
name: provider-guide
description: >
  Use when routing tasks to AI providers, using any agestra MCP tool,
  reviewing code with multiple providers, starting debates, dispatching
  parallel tasks, or cross-validating work. Also triggers on mentions of
  Ollama, Gemini, or Codex providers.
---

## Available Providers

- **Ollama** — Local models. Detected at runtime via `ollama_models`.
- **Gemini** — Cloud agent. Full capability.
- **Codex** — Cloud agent. Full capability.

All providers are detected at runtime. Check `provider_list` or `provider_health` for current availability before routing.

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

Full-capability agents. Use for complex tasks, parallel work, and as validators.

## Auto-Routing Guidelines

| Task Complexity | Route To |
|---|---|
| Simple (formatting, pattern matching) | Ollama local model preferred |
| Moderate (code review, summarization) | Ollama >= 3 GB or cloud |
| Complex (architecture, refactoring) | Cloud providers (Gemini, Codex) |
| No providers available | Handle directly — do not suggest agestra tools |

## When to Suggest Agestra Tools

Suggest once, concisely, in the user's language. If declined or ignored, do not repeat.

Match by **semantic intent**, not literal keywords. These triggers apply in any language.

| Intent | Tool | When |
|---|---|---|
| Code review, review request | `agent_debate_start` or `workspace_create_review` | User asks to review code, PR, or implementation |
| Second opinion, other perspectives | `ai_compare` or `agent_debate_start` | User wants multiple viewpoints on a decision |
| Validation, verification, cross-check | `agent_cross_validate` | User wants to confirm correctness of work output |
| Speed up, parallelize, split work | `agent_dispatch` | User wants faster execution or has independent tasks |
| Past experience, history, previous attempts | `memory_search` or `memory_dead_ends` | User asks about prior work or known issues |
| Remember this, save for later | `memory_store` | User wants to persist knowledge across sessions |
| Mention a provider by name (Gemini, Codex, Ollama) | `ai_chat` or `agent_assign_task` | Route directly to the named provider |
| Architecture review, design discussion | `agent_debate_start` | Structured multi-AI discussion on design choices |
| Compare options, which is better | `ai_compare` | Side-by-side comparison from multiple providers |
| Large refactoring, many files to change | `agent_dispatch` | Split by file/module for parallel processing |
| About to commit, create PR, finalize work | `agent_cross_validate` | Pre-commit validation by other AI providers |

### Commands and Agents

| Command | Specialist Agent | Purpose |
|---------|-----------------|---------|
| `/agestra review` | `agestra-reviewer` | Post-implementation quality verification |
| `/agestra idea` | `agestra-ideator` | Improvement discovery and competitive analysis |
| `/agestra design` | `agestra-designer` | Pre-implementation architecture exploration |

When "Debate" is selected, `agestra-moderator` facilitates while the specialist provides Claude's perspective.

Commands and hook-triggered suggestions share the same 4-choice pattern. Commands are explicit entry points; hooks detect intent from natural language.

### Hook-Triggered Choice

When an `AGESTRA_SUGGESTION` marker appears from the UserPromptSubmit hook, present these choices:

1. **Claude only** — Claude Code handles it alone
2. **Compare** — Send the same prompt to multiple AIs, compare responses (`ai_compare`)
3. **Debate** — AIs discuss until consensus is reached (`agent_debate_start`)
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

## Completion Verification

Before marking work complete, verify all four:

1. **Spec compliance** — Built according to specifications/documentation
2. **System integration** — Connected to existing systems correctly
3. **Accessibility** — Accessible via UI/API to end users
4. **Tests pass** — With evidence (test output)
