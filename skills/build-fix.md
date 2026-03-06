---
name: build-fix
description: >
  Use when build fails, TypeScript type errors occur, lint errors need fixing,
  or compilation errors block progress. Triggers on: build failure output,
  "tsc" errors, "build failed", "fix build", "type error", "lint error",
  "compilation error".
---

## Purpose

Automatically diagnoses and fixes build/typecheck/lint errors with minimal scope changes, one error at a time, highest-impact first.

## Strategy: One-at-a-Time

Many build errors are cascading — one root cause produces multiple error messages. Fixing all at once risks unnecessary changes. Instead:

1. Fix the **first** (or most impactful) error
2. Rebuild to see which errors remain
3. Repeat until clean

## Workflow

### Step 1: Identify Errors

Run the appropriate build command for the project:

| Detected Project Type | Command |
|---|---|
| `tsconfig.json` present | `npx tsc --noEmit 2>&1` |
| `turbo.json` present | `npx turbo build 2>&1` |
| `package.json` with `build` script | `npm run build 2>&1` |
| ESLint configured | `npx eslint . 2>&1` |

If the user provided specific error output, use that instead of re-running.

### Step 2: Triage

Parse errors and rank by impact:
1. **Syntax errors** — block all downstream compilation
2. **Missing imports/exports** — cascade to many dependents
3. **Type mismatches** — usually isolated
4. **Lint warnings** — lowest priority

### Step 3: Fix Loop (max 5 cycles)

For each cycle:

1. Read the file containing the highest-priority error
2. Diagnose the root cause (not the symptom)
3. Apply the **minimal** fix — do not refactor surrounding code
4. Re-run the build command
5. If errors remain, continue to next cycle
6. If no errors remain or same error persists 3 times, stop

### Step 4: Report

Present results to the user:

```
Build Fix Summary
- Cycles: {n}
- Errors fixed: {count}
- Remaining errors: {count or "none"}
- Files modified: {list}
```

If errors remain after 5 cycles, list them and suggest manual investigation.

## Constraints

- **Minimal changes only** — fix the error, nothing else
- **No refactoring** — do not "improve" code while fixing
- **No new dependencies** — do not add packages to fix type errors
- **Preserve behavior** — fixes must not change runtime behavior
- **Read before edit** — always read the full file before modifying
