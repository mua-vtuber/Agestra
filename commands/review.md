---
description: "Review code quality, security, and integration completeness"
argument-hint: "[target file, directory, or description]"
---

You are executing the `/agestra review` command.

**Target:** $ARGUMENTS

## Step 1: Determine review target

If `$ARGUMENTS` is empty, ask the user what to review using AskUserQuestion:
- "What would you like to review? (file path, directory, or description)"

## Step 2: Check available providers

Call `provider_list` to check which external AI providers (Ollama, Gemini, Codex) are currently available.

If no providers are available, skip to running the `reviewer` agent directly (Claude only).

## Step 3: Present choices

Use AskUserQuestion to present these options (in the user's language):

| Option | Description |
|--------|-------------|
| **Claude only** | Claude's reviewer agent performs the review alone |
| **Compare** | Send the review prompt to multiple AIs and compare their findings |
| **Debate** | AIs discuss the code quality until they reach consensus |

## Step 4: Execute based on selection

### If "Claude only":
Spawn the `reviewer` agent with the target as context. The reviewer will examine the code using its 7-point checklist (security, orphan systems, missing UI, hardcoding, i18n, spec drift, test coverage).

### If "Compare":
Call `ai_compare` with all available providers. Use this prompt template:

> Review the following code for: security vulnerabilities (OWASP top 10), orphan systems, missing UI for user features, hardcoded config values, i18n issues, spec drift, and test coverage gaps. For each finding, provide severity (CRITICAL/HIGH/MEDIUM/LOW), file:line location, and evidence.
>
> Target: [the review target]

### If "Debate":
Spawn the `moderator` agent with this context:

> Topic: Code quality review of [target]
> Specialist perspective: reviewer — strict quality verification focusing on security, orphan systems, missing UI, hardcoding, i18n, spec drift, and test coverage.
> Each participant should independently evaluate the code and report findings with severity and evidence.

### If "Other":
Follow the user's specified approach.
