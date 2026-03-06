---
description: "Explore architecture and design trade-offs before implementation"
argument-hint: "[idea, feature, or system to design]"
---

You are executing the `/agestra design` command.

**Subject:** $ARGUMENTS

## Step 1: Determine design subject

If `$ARGUMENTS` is empty, present a starting-point choice using AskUserQuestion (in the user's language):

| Option | Description |
|--------|-------------|
| **Describe an idea** | User has a specific feature or system in mind — proceed to designer |
| **Find ideas first** | User doesn't know what to design yet — run `/agestra idea` to discover opportunities, then return here |
| **Use recent context** | Organize ideas from the current conversation into a design subject |

- If **"Describe an idea"**: ask a follow-up "What would you like to design?" and proceed.
- If **"Find ideas first"**: run the `agestra-ideator` agent (or `/agestra idea`) to generate suggestions. After the user selects an idea from the results, continue to Step 2 with that as the subject.
- If **"Use recent context"**: scan the current conversation for previously discussed ideas, improvements, or features. Summarize them and ask the user which to design.

If `$ARGUMENTS` is provided, use it directly as the subject.

## Step 2: Check available providers

Call `provider_list` to check which external AI providers (Ollama, Gemini, Codex) are currently available.

If no providers are available, skip to running the `agestra-designer` agent directly (Claude only).

## Step 3: Present choices

Use AskUserQuestion to present these options (in the user's language):

| Option | Description |
|--------|-------------|
| **Claude only** | Claude's agestra-designer agent explores architecture through Socratic questioning |
| **Compare** | Multiple AIs independently propose architecture approaches |
| **Debate** | AIs discuss architecture trade-offs until they reach consensus |

## Step 4: Execute based on selection

### If "Claude only":
Spawn the `agestra-designer` agent with the subject as context. The designer will ask questions to understand intent, explore the codebase for existing patterns, propose 2-3 approaches with trade-offs, refine based on feedback, and produce a design document in `docs/plans/`.

### If "Compare":
1. Call `ai_compare` with all available providers and `aggregate_provider` set to the most capable available provider. Use this prompt template:

   > Propose an architecture approach for [subject]. Consider existing patterns in the codebase, trade-offs (complexity, performance, maintainability), and implementation steps. Present 2-3 distinct approaches with pros/cons for each.
   >
   > Subject: [the design subject]

2. The aggregated synthesis is included in the response. Present the unified architecture analysis to the user, highlighting where providers agree/disagree on approach.

### If "Debate":
1. Spawn the `agestra-moderator` agent with this context:

   > Topic: Architecture design for [subject]
   > Specialist perspective: agestra-designer — pre-implementation architecture explorer using Socratic questioning and trade-off analysis. Focuses on finding the right approach before writing code.
   > Each participant should propose their preferred architecture approach with rationale, then discuss trade-offs and reach a recommendation.

2. After the debate concludes and a document is produced, run a **document review round**:
   - Call `agent_debate_review` with the debate's conclusion document and all participating providers.
   - If any provider disagrees, revise the document addressing their feedback and call `agent_debate_review` again.
   - Repeat until all providers agree or 3 review rounds have been completed.
   - Present the final reviewed document to the user.

### If "Other":
Follow the user's specified approach.
