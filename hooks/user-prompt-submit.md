---
event: UserPromptSubmit
---

Analyze the user's message for intent that matches agestra multi-AI capabilities.

## Detection Rules

Match by **semantic intent** in ANY language (Korean, English, Japanese, etc.):

- **Code review / review request** → Suggest `agent_debate_start` or `workspace_create_review`
- **Second opinion / other perspectives** → Suggest `ai_compare` or `agent_debate_start`
- **Validation / verification** → Suggest `agent_cross_validate`
- **Speed up / parallelize** → Suggest `agent_dispatch`
- **Mentions Gemini, Codex, or Ollama by name** → Route to `ai_chat` or `agent_assign_task`
- **Architecture review / design discussion** → Suggest `agent_debate_start`
- **Compare options** → Suggest `ai_compare`
- **Large refactoring** → Suggest `agent_dispatch`
- **About to commit / create PR** → Suggest `agent_cross_validate`

## Response Format

If a match is found, output:

```
AGESTRA_SUGGESTION: {tool_name}
Present the user with a choice:
1. Claude Code handles it alone
2. Multi-AI analysis with available providers
```

If no match, output nothing (empty response).

## Rules

- Suggest once per conversation turn. If declined or ignored, do not repeat.
- Respond in the user's language.
- Match semantic intent, not literal keywords.
