---
name: worker-manage
description: >
  Use when managing CLI worker processes — checking status, collecting results,
  stopping workers, or viewing active workers. Triggers on: "worker status",
  "check workers", "stop worker", "worker results", "워커 상태", "워커 중지".
---

Wraps `cli_worker_spawn`, `cli_worker_status`, `cli_worker_collect`, `cli_worker_stop` into user-friendly operations.

## Operations

### List Active Workers

Call `cli_worker_status` for all known workers.

Present a table:

| Worker ID | Provider | Status | Elapsed | Files Changed |
|-----------|----------|--------|---------|---------------|
| codex-auth-abc | codex | RUNNING | 45s | 2 |
| gemini-api-def | gemini | COMPLETED | 120s | 5 |

### Check Worker Status

For a specific worker, call `cli_worker_status` with the worker ID.

Show:
- Current FSM state
- Elapsed time
- Last 20 lines of output
- Files changed so far
- Worktree branch name
- Retry count

### Collect Results

For a completed worker, call `cli_worker_collect` with the worker ID.

Present:
- Exit code
- Git diff summary (files changed, insertions, deletions)
- Full output (or truncated if very long)
- Worktree branch

Then ask the user using AskUserQuestion:

| Option | Description |
|--------|-------------|
| **Merge** | Accept changes and merge worker branch to main |
| **Review diff** | Show the full diff before deciding |
| **Reject** | Discard changes and clean up worktree |

### Stop Worker

Call `cli_worker_stop` with the worker ID.

The worker receives SIGTERM, then SIGKILL after 5 seconds if still running.
Worktree is cleaned up after the worker stops.

Confirm before stopping:
- "Worker [id] is currently RUNNING (elapsed: Xs). Stop it?"

### Stop All Workers

If the user says "stop all workers" or similar:
1. List all RUNNING workers.
2. Confirm: "Stop all N running workers?"
3. Call `cli_worker_stop` for each.

## Error Handling

- If a worker ID is not found: "No worker found with ID [id]. Use 'list workers' to see active workers."
- If trying to collect from a RUNNING worker: "Worker [id] is still running. Wait for completion or stop it first."
- If trying to stop an already completed worker: "Worker [id] has already finished (state: COMPLETED)."
