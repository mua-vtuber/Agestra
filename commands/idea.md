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

If no providers are available, skip to running the `agestra-ideator` agent directly (Claude only).

## Step 3: Present choices

Use AskUserQuestion to present these options (in the user's language):

| Option | Description |
|--------|-------------|
| **Claude only** | Claude's agestra-ideator agent researches improvements alone |
| **Compare** | Multiple AIs independently research and suggest improvements |
| **Debate** | AIs discuss potential improvements and priorities until consensus |

## Step 4: Execute based on selection

### If "Claude only":
Spawn the `agestra-ideator` agent with the topic as context. The ideator will research similar projects, collect user complaints, build feature comparisons, and generate prioritized recommendations.

### If "Compare":
1. Call `ai_compare` with all available providers and `aggregate_provider` set to the most capable available provider. Use this prompt template:

   > Research improvements for [topic]. Look at similar projects, common user complaints, missing features, and opportunities. For each suggestion, provide: title, category (UX/Performance/Feature/Integration/DX), source of the idea, priority (HIGH/MEDIUM/LOW), and a brief description.
   >
   > Topic: [the topic]

2. The aggregated synthesis is included in the response. Present the unified improvement list to the user, noting which ideas were suggested by multiple providers.

### If "Debate":
1. Spawn the `agestra-moderator` agent with this context:

   > Topic: Improvement opportunities for [topic]
   > Specialist perspective: agestra-ideator — researches similar projects, collects user feedback, identifies gaps and opportunities. Focuses on actionable, prioritized suggestions.
   > Each participant should propose their top improvement ideas with rationale, then discuss priorities and feasibility.

2. After the debate concludes and a document is produced, run a **document review round**:
   - Call `agent_debate_review` with the debate's conclusion document and all participating providers.
   - If any provider disagrees, revise the document addressing their feedback and call `agent_debate_review` again.
   - Repeat until all providers agree or 3 review rounds have been completed.
   - Present the final reviewed document to the user.

### If "Other":
Follow the user's specified approach.
