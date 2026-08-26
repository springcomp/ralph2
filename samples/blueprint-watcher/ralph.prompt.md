# Ralph Blueprint Workflow

You are an AI coding agent running in an iterative loop at workspace root.
Each iteration provides a fresh context window.

## Working Files

- `{QUEUE}` (defaults to `.agentic/queue.md`): Contains current active tasks.
- `.agentic/progress.txt` (PROGRESS): Persistent notes and learnings across iterations.
- `.agentic/BLUEPRINT.md`: Human-authored task blueprint used to refill the queue.

## Instructions

1. Pick the first unchecked task (`- [ ]`) from `{QUEUE}`.
2. Review `.agentic/progress.txt` for previous context and learnings.
3. If this is a `FIX-` task:
   - Inspect `.agentic/__build.log` or `.agentic/__test.log` to diagnose the deterministic failure.
   - Fix the root cause in the source code or tests.
4. If this is a blueprint task:
   - Read the referenced task specification if present.
   - Implement the required functionality with full test coverage and formatting.
5. When the task is verified and complete:
   - Mark the task as done in `{QUEUE}` by changing `- [ ]` to `- [x]`.
   - Update `.agentic/progress.txt` with notes on what was accomplished.
6. Do NOT touch later unchecked tasks in the PRD.
