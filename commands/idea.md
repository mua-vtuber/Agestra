---
description: "Discover improvements by comparing with similar projects and collecting feedback"
argument-hint: "[topic or project area]"
---

You are executing the `/agestra idea` command.

**Topic:** $ARGUMENTS

## Step 1: Determine topic

If `$ARGUMENTS` is empty, ask the user what area to explore using AskUserQuestion:
- "What area would you like to find improvements for? (feature area, project aspect, or general)"

## Step 2: Check available providers

Call `provider_list` to check which external AI providers (Ollama, Gemini, Codex) are currently available.

If no providers are available, skip to running the `ideator` agent directly (Claude only).

## Step 3: Present choices

Use AskUserQuestion to present these options (in the user's language):

| Option | Description |
|--------|-------------|
| **Claude only** | Claude's ideator agent researches improvements alone |
| **Compare** | Multiple AIs independently research and suggest improvements |
| **Debate** | AIs discuss potential improvements and priorities until consensus |

## Step 4: Execute based on selection

### If "Claude only":
Spawn the `ideator` agent with the topic as context. The ideator will research similar projects, collect user complaints, build feature comparisons, and generate prioritized recommendations.

### If "Compare":
Call `ai_compare` with all available providers. Use this prompt template:

> Research improvements for [topic]. Look at similar projects, common user complaints, missing features, and opportunities. For each suggestion, provide: title, category (UX/Performance/Feature/Integration/DX), source of the idea, priority (HIGH/MEDIUM/LOW), and a brief description.
>
> Topic: [the topic]

### If "Debate":
Spawn the `moderator` agent with this context:

> Topic: Improvement opportunities for [topic]
> Specialist perspective: ideator — researches similar projects, collects user feedback, identifies gaps and opportunities. Focuses on actionable, prioritized suggestions.
> Each participant should propose their top improvement ideas with rationale, then discuss priorities and feasibility.

### If "Other":
Follow the user's specified approach.
