---
description: "Review code quality, security, and integration completeness"
argument-hint: "[target file, directory, or description]"
---

You are executing the `/agestra review` command.

**Target:** $ARGUMENTS

## Step 1: Determine review target

If `$ARGUMENTS` is empty, ask the user what to review using AskUserQuestion:
- "What would you like to review? (file path, directory, or description)"

## Step 2: Check environment and available providers

Call `environment_check` to determine which providers and modes are available.

If no providers are available, skip to running the `agestra-reviewer` agent directly (Claude only).

## Step 3: Present choices

Use AskUserQuestion to present these options (in the user's language):

| Option | Condition | Description |
|--------|-----------|-------------|
| **Claude only** | Always | 플러그인 전문 에이전트가 단독 리뷰 |
| **각자 독립** | 1+ provider available | 각 AI가 독립 리뷰 후 진행자가 취합하여 문서 작성 |
| **끝장토론** | 1+ provider available | 각자 독립 + 문서를 돌아가며 분석/피드백, 모두 동의할 때까지 |

Only show options whose conditions are met. If no providers are available, skip and run Claude only.

## Step 4: Execute based on selection

### If "Claude only":
Spawn the `agestra-reviewer` agent with the target as context. The reviewer will examine the code using its 7-point checklist (security, orphan systems, missing UI, hardcoding, i18n, spec drift, test coverage).

### If "각자 독립":
1. In parallel:
   - Spawn the `agestra-reviewer` agent for Claude's independent analysis.
   - For each available provider, call `ai_chat` with this prompt:

     > Review the following code for: security vulnerabilities (OWASP top 10), orphan systems, missing UI for user features, hardcoded config values, i18n issues, spec drift, and test coverage gaps. For each finding, provide severity (CRITICAL/HIGH/MEDIUM/LOW), file:line location, and evidence.
     >
     > Target: [the review target]

2. Collect all results (Claude's reviewer output + each provider's response).
3. Spawn the `agestra-moderator` agent in **Independent Aggregation** mode:
   - Pass ALL results as input, tagged by source provider.
   - Moderator classifies: consensus findings, unique findings, disputed points.
   - Moderator generates an integrated document.
4. Present the integrated document to the user.

### If "끝장토론":
1. Execute "각자 독립" steps 1-3 above (independent work + initial aggregation).
   - The moderator's integrated document becomes the starting document.

2. Document review rounds (max 5):
   a. Moderator sends the current document to each AI for review:
      - Claude: spawn `agestra-reviewer` → analyze document → write section-by-section feedback
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
