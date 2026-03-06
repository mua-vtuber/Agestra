---
description: "Discover improvements by comparing with similar projects and collecting feedback"
argument-hint: "[topic or project area]"
---

You are executing the `/agestra idea` command.

**Topic:** $ARGUMENTS

## Step 1: Determine topic

If `$ARGUMENTS` is empty, ask the user what area to explore using AskUserQuestion:
- "What area would you like to find improvements for? (feature area, project aspect, or general)"

## Step 2: Check environment and available providers

Call `environment_check` to determine which providers and modes are available.

If no providers are available, skip to running the `agestra-ideator` agent directly (Claude only).

## Step 3: Present choices

Use AskUserQuestion to present these options (in the user's language):

| Option | Condition | Description |
|--------|-----------|-------------|
| **Claude only** | Always | 플러그인 전문 에이전트가 단독으로 개선점 탐색 |
| **각자 독립** | 1+ provider available | 각 AI가 독립적으로 개선점 탐색 → 진행자가 취합하여 문서 작성 |
| **끝장토론** | 1+ provider available | 각자 독립 + 문서를 돌아가며 분석/피드백, 모두 동의할 때까지 |

Only show options whose conditions are met. If no providers are available, skip and run Claude only.

## Step 4: Execute based on selection

### If "Claude only":
Spawn the `agestra-ideator` agent with the topic as context. The ideator will research similar projects, collect user complaints, build feature comparisons, and generate prioritized recommendations.

### If "각자 독립":
1. In parallel:
   - Spawn the `agestra-ideator` agent for Claude's independent improvement research.
   - For each available provider, call `ai_chat` with this prompt:

     > Research improvements for [topic]. Look at similar projects, common user complaints, missing features, and opportunities. For each suggestion, provide: title, category (UX/Performance/Feature/Integration/DX), source of the idea, priority (HIGH/MEDIUM/LOW), and a brief description.
     >
     > Topic: [the topic]

2. Collect all results (Claude's ideator output + each provider's response).
3. Spawn the `agestra-moderator` agent in **Independent Aggregation** mode:
   - Pass ALL results as input, tagged by source provider.
   - Moderator classifies: consensus suggestions, unique ideas, disputed priorities.
   - Moderator generates an integrated improvement document.
4. Present the integrated document to the user.

### If "끝장토론":
1. Execute "각자 독립" steps 1-3 above (independent work + initial aggregation).
   - The moderator's integrated document becomes the starting document.

2. Document review rounds (max 5):
   a. Moderator sends the current document to each AI for review:
      - Claude: spawn `agestra-ideator` → analyze document → write section-by-section feedback
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
