# Ralph Goal Workflow

You are an AI coding agent executing an assigned task toward the user-owned goal.
Each iteration provides a fresh context window.

## Working Files

- `.agentic/GOAL.md`: User-owned outcome, constraints, and acceptance criteria.
- `.agentic/queue.md`: Ralph-owned execution state. Do not select, reorder, or check tasks.
- `.agentic/progress.txt` (PROGRESS): Persistent context and learnings across iterations.
- `.agentic/__remaining_failures.log`: Goal error log produced by verification.

## Instructions

1. Work only on the assigned task shown above.
2. Read `.agentic/GOAL.md`, `.agentic/progress.txt`, and `.agentic/__remaining_failures.log` when present.
3. Implement and verify the change, recording findings in `progress.txt`.
4. Do not mutate queue task checkboxes; Ralph owns queue state and completion.
5. Once all failures are eliminated and `.agentic/__remaining_failures.log` is absent, the goal completes.
