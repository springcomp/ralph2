# Ralph Blueprint Workflow

You are an AI coding agent running in an iterative loop at workspace root.
Each iteration provides a fresh context window.

## Working Files

- `{QUEUE}`: Contains current active tasks.
- `{PROGRESS}`: Persistent notes and learnings across iterations.
- `BLUEPRINT.md`: Human-authored task blueprint used to refill the queue.

## Instructions

1. Pick the first unchecked task (`- [ ]`) from `{QUEUE}`.
2. Review `{PROGRESS}` for previous context and learnings.
3. Implement the required functionality with full test coverage and formatting.
4. When the task is verified and complete:
   - Mark the task as done in `{QUEUE}` by changing `- [ ]` to `- [x]`.
   - Update `{PROGRESS}` with notes on what was accomplished.
5. Do NOT touch later unchecked tasks in the queue.
