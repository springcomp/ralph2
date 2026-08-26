# TASK-003 — Implement engine-owned successful task completion

## Objective
Let goal workflow commit task completion in Ralph only after all configured work and deterministic gates succeed.

## Implementation
1. Add explicit successful-task completion hook/flag to `src/core/plan.ts`.
2. Lower `tasks.completion: engine` from compiled workflow into that core behavior in `src/config/compiler.ts` / `compileCore`.
3. In `src/core/engine-core.ts`, after non-terminal pipeline success and successful guard evaluation, invoke `TaskSource.checkTask(ctx.task)` for engine-owned tasks.
4. Perform state transition before `source.afterTask(ctx)` so generated-goal producer sees committed prior task state.
5. Convert completion-write error into blocked outcome with useful message.
6. Preserve current behavior for agent-owned workflows, including `verification.requireTaskChecked` retry/check semantics.

## Acceptance criteria
- Engine-owned task is checked exactly once after harness and post-agent stages pass.
- Producer/continuation runs only after successful check operation.
- Harness/post-agent failure, terminal verification failure, cancellation, and guard block leave task unchecked.
- Completion-write error blocks workflow rather than silently continuing.
- Legacy/blueprint agent-owned workflow behavior does not auto-check tasks.
