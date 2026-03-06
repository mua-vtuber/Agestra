---
name: trace
description: >
  Use when the user wants to see agent execution flow, debug agent interactions,
  view timeline of recent operations, or understand what happened during a
  multi-AI session. Triggers on: "trace", "what happened", "show flow",
  "agent timeline", "execution history", "bottleneck", "performance".
---

## Purpose

Wraps the `trace_query`, `trace_summary`, and `trace_visualize` MCP tools into a single cohesive workflow for inspecting agent execution history.

## Usage

When this skill activates, determine what the user wants and route accordingly:

### Timeline View (default)

Show chronological agent execution flow:

1. Call `trace_query` with appropriate filters (recent by default, or user-specified time range / event type)
2. Present results as a formatted timeline:
   ```
   [timestamp] event_type — provider — duration — status
   ```
3. Highlight anomalies: failed events, unusually long durations, repeated retries

### Summary View

Aggregate statistics for a session or time range:

1. Call `trace_summary` to get aggregate data
2. Present:
   - Total events by type (debate turns, dispatches, comparisons, memory ops)
   - Provider usage breakdown (which providers were called, how often)
   - Success/failure rates per provider
   - Average response times
   - Bottleneck identification (slowest operations)

### Visual Flow

For complex multi-agent interactions:

1. Call `trace_visualize` to get a flow diagram
2. Present the visualization to the user
3. Annotate key decision points and branching

## Routing Logic

| User Intent | Action |
|---|---|
| "what happened" / "show trace" / no specific request | Timeline View (last 20 events) |
| "summary" / "stats" / "how did it go" | Summary View |
| "flow" / "diagram" / "visualize" | Visual Flow |
| Specific event ID or time range | Timeline View with filters |

## Error Handling

- If no trace data exists: inform the user that no agent activity has been recorded yet
- If trace tools are unavailable: suggest the user check that the Agestra MCP server is running
