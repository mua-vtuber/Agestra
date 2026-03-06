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

## Step 2: Check environment and available providers

Call `environment_check` to determine which providers and modes are available.

If no providers are available, skip to running the `agestra-designer` agent directly (Claude only).

## Step 3: Present choices

Use AskUserQuestion to present these options (in the user's language):

| Option | Condition | Description |
|--------|-----------|-------------|
| **Claude only** | Always | 플러그인 전문 에이전트가 소크라테스식 질문으로 아키텍처 탐색 |
| **각자 독립** | 1+ provider available | 각 AI가 독립적으로 아키텍처 제안 → 진행자가 취합하여 문서 작성 |
| **끝장토론** | 1+ provider available | 각자 독립 + 문서를 돌아가며 분석/피드백, 모두 동의할 때까지 |

Only show options whose conditions are met. If no providers are available, skip and run Claude only.

## Step 4: Execute based on selection

### If "Claude only":
Spawn the `agestra-designer` agent with the subject as context. The designer will ask questions to understand intent, explore the codebase for existing patterns, propose 2-3 approaches with trade-offs, refine based on feedback, and produce a design document in `docs/plans/`.

### If "각자 독립":
1. In parallel:
   - Spawn the `agestra-designer` agent for Claude's independent architecture exploration.
   - For each available provider, call `ai_chat` with this prompt:

     > Propose an architecture approach for [subject]. Consider existing patterns in the codebase, trade-offs (complexity, performance, maintainability), and implementation steps. Present 2-3 distinct approaches with pros/cons for each.
     >
     > Subject: [the design subject]

2. Collect all results (Claude's designer output + each provider's response).
3. Spawn the `agestra-moderator` agent in **Independent Aggregation** mode:
   - Pass ALL results as input, tagged by source provider.
   - Moderator classifies: consensus approaches, unique ideas, disputed trade-offs.
   - Moderator generates an integrated architecture document.
4. Present the integrated document to the user.

### If "끝장토론":
1. Execute "각자 독립" steps 1-3 above (independent work + initial aggregation).
   - The moderator's integrated document becomes the starting document.

2. Document review rounds (max 5):
   a. Moderator sends the current document to each AI for review:
      - Claude: spawn `agestra-designer` → analyze document → write section-by-section feedback
      - Other providers: `agent_debate_turn` with the document as prompt, requesting agree/disagree per section
   b. Moderator collects all feedback.
   c. Classify: agree/disagree per section per provider.
   d. Revise document incorporating disagreement feedback.
   e. If all providers agree on all sections → consensus reached.
   f. If not → next round with revised document.

3. Present the final document:
   - Consensus sections: marked as agreed
   - Disputed sections: show split positions with each provider's rationale

### If "Other":
Follow the user's specified approach.
