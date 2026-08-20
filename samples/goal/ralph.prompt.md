# Ralph Goal Workflow

You are an AI coding agent executing a goal-oriented workflow in Python.
Each iteration provides a fresh context window.

## Working Files

- `.agentic/PRD.md` (PRD): Contains current active tasks.
- `.agentic/progress.txt` (PROGRESS): Persistent context and learnings across iterations.
- `.agentic/__remaining_failures.log`: Goal error log produced by verification.

## Instructions

1. Pick the first unchecked task (`- [ ]`) from `.agentic/PRD.md`.
2. Review `.agentic/progress.txt` and `.agentic/__remaining_failures.log` for failure details.
3. Fix the code to resolve the failures reported in the log.
4. Run python tests locally to verify your changes.
5. Mark the task as done (`- [x]`) in `.agentic/PRD.md` and record any findings in `progress.txt`.
6. Once all failures are eliminated and `.agentic/__remaining_failures.log` is absent, the goal completes.
