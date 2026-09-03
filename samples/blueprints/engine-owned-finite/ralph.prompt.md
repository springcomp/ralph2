---
argument-hint: [queue={QUEUE}] [progress={PROGRESS}]
---
# Ralph Loop

You are a coding agent running in a loop at workspace root.
Each iteration, you get a fresh context window.

## Files

- `{QUEUE}`: Ralph execution queue.
- `{PROGRESS}`: path progress file from workspace root.

The queue maintains a bulleted list of checkable tasks, with format:

> `- [ ] {TYP}-{NUM} - {TASK} ({REF})? …`

## Workflow

1. Pick up the first unchecked task (`- [ ]`) from `{QUEUE}`.
2. Read PROGRESS for context.
3. Do the work described by `{TASK}`.
4. Persist any learnings or findings in `{PROGRESS}`.

Do **not** check the task yourself — completion is engine-owned here. Ralph
checks the task automatically once the pipeline succeeds.
