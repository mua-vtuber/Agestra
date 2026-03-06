---
name: cancel
description: >
  Use when the user wants to stop, cancel, or abort a running operation.
  Triggers on: "cancel", "stop", "abort", "enough", "quit", "중단", "취소",
  "그만". Performs graceful shutdown with state cleanup.
---

## Purpose

Gracefully cancels running Agestra operations and cleans up associated state. Detects which operation is active and performs appropriate cleanup.

## Detection

Check for active operations in this order:

1. **CLI Workers** — Call `cli_worker_status` to check for workers in RUNNING or SPAWNING state
2. **Debate** — Call `agent_debate_status` to check for active debates
3. **Task Chain** — Call `agent_task_chain_status` to check for running chains
4. **Task** — Call `agent_task_status` for individual running tasks
5. **Background agents** — Check for any spawned background agents still running

If nothing is detected as active, inform the user: "No active Agestra operations found."

If multiple types are active, list them all and ask the user which to cancel (or all).

## Cleanup by Operation Type

### CLI Workers
1. List all workers in RUNNING/SPAWNING state with their provider, elapsed time, and task description.
2. Ask the user which to stop (or all):
   - Single worker: call `cli_worker_stop` with the worker ID.
   - All workers: call `cli_worker_stop` for each.
3. Workers receive SIGTERM, then SIGKILL after 5 seconds.
4. Worktrees are cleaned up automatically.
5. Report: which workers were stopped, any partial results available via `cli_worker_collect`.

### Debate
1. Call `agent_debate_conclude` with a summary noting early termination
2. Inform the user which providers participated and how many rounds completed

### Task Chain
1. Note the current step and remaining steps
2. Let the current step finish if nearly complete, otherwise stop
3. Report: completed steps, skipped steps, any partial results

### Individual Task
1. Wait for current provider response if in-flight (do not interrupt mid-response)
2. Report the task status and any partial results

### Background Agents
1. List running background agents with their descriptions
2. Ask the user which to cancel (or all)
3. Stop selected agents

## Post-Cleanup

After cancellation:
- Summarize what was stopped and what completed
- Note any artifacts produced (debate documents, partial results, worker diffs)
- If CLI workers produced changes before stopping, mention that partial diffs may be available via `cli_worker_collect`
- If the operation produced useful partial work, mention it so the user can resume later

## Constraints

- **Never discard results silently** — always report what was produced before cancellation
- **Prefer graceful over forced** — let in-flight operations finish when possible
- **Ask before bulk cancel** — if multiple operations are running, confirm which to stop
