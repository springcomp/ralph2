# TASK-002 - Phase 1: Core vocabulary types

## Context

Ref: [plans/CORE_LOOP.md](../plans/CORE_LOOP.md) — Phase 1, target core vocabulary.

Introduce the new minimal IR types the tiny engine will consume. Purely additive: no
existing file is modified, no runtime behavior changes.

## Implementation steps

1. Create `src/core/plan.ts` defining:
   - `Step` interface: `run(ctx): Promise<StepResult>`, `onFail: Policy`,
     `role: "pre" | "harness" | "post" | "verify"`, `name: string`.
   - `Policy` union: `stop`, `continue`, `retry { predicate, times }`,
     `schedule { action, maxAttempts }`.
   - `WorkSource` interface: `pull(iteration): Promise<Task | null>` (pure — no side
     effects), optional `afterTask?(ctx): Promise<void>`.
   - `Guard` interface: `kind`, `threshold`, `signature(ctx): Promise<string | null>`.
   - `Predicate` interface: `check(ctx): Promise<boolean>`.
   - `CorePlan` interface: `workspace`, `maxIterations`, `source: WorkSource`,
     `steps: Step[]`, `guards: Guard[]`, `status(ctx): string`.
   - `StepResult` / `Outcome` types needed to support Phase 3's pipeline (define now so
     the shape is fixed, per the plan's `Outcome` note in Phase 3).
2. Reuse existing types where possible (`Task` from `src/core/task.ts`,
   `ProcessResult` from `src/core/process-runner.ts`) instead of redefining them.
3. Add unit tests in `tests/core/plan.test.ts` that just typecheck/construct minimal
   instances of each interface (compile-time contract test), no engine wiring yet.

## Acceptance criteria

- [ ] `src/core/plan.ts` exists exporting `Step`, `Policy`, `WorkSource`, `Guard`,
      `Predicate`, `CorePlan`, `StepResult`, `Outcome`.
- [ ] No existing file under `src/` or `bootstrap/` is modified.
- [ ] `pnpm tsc --noEmit` (or project build) passes.
- [ ] `pnpm vitest run` stays green; new `tests/core/plan.test.ts` passes.
