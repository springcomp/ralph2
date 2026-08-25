# TASK-004 - Phase 3: New tiny engine over CorePlan

## Context

Ref: [plans/CORE_LOOP.md](../plans/CORE_LOOP.md) — Phase 3 and "Target engine loop".

Implement the ~40-line loop and its `Outcome`-based pipeline, running in parallel to the
existing `WorkflowEngine` (no cutover yet). Validate against the Phase 0 goldens driven
through `CorePlan`.

## Implementation steps

1. Create `src/core/pipeline.ts`: `run(steps, ctx, i)` applying `Policy` uniformly per
   step (`stop`, `continue`, `retry`, `schedule`). Replace the current leaky
   `handleFailure` union return (`WorkflowRunResult | "scheduled" | null`) with a single
   `Outcome` type (as defined in TASK-002), used only by the new pipeline — the old
   `engine.ts` is untouched.
2. Create `src/core/engine-core.ts` implementing the loop from the plan:
   - `lock.acquire()`, iterate `1..maxIterations`, check abort → `canceled`.
   - `source.pull(i)` → `null` means `complete`.
   - Build placeholder context via the existing builder (`values(task, i)` equivalent),
     reusing `PlaceholderExpander`.
   - Emit `task.started` + status events identical to today's event protocol.
   - `pipeline.run(steps, ctx, i)`; terminal outcomes (`blocked` / `processFailure` /
     `canceled`) return immediately.
   - Run guards (`guards.trip(i, outcome.lastFailure)`) reusing `evaluateCircuitBreaker`
     → `blocked` on trip.
   - Call `source.afterTask?.(ctx)` (goal producer/predicate hook).
   - Fall through to `iterationLimit` when the loop exhausts `maxIterations`.
3. Preserve exactly: event protocol (`ralph.event type=... iteration=... stage=...
   message=...` and every event type), exit codes (`0/2/3/4/5`) and their triggering
   conditions.
4. Drive the Phase 0 golden tests through `compileCore()` + `engine-core.ts` (new test
   variants alongside the existing ones, not replacing them) and diff event sequences /
   exit codes against the Phase 0 baseline recordings.

## Acceptance criteria

- [ ] `src/core/pipeline.ts` and `src/core/engine-core.ts` exist; `src/core/engine.ts`
      is untouched and still used by the CLI.
- [ ] All Phase 0 golden scenarios pass when run through `compileCore()` +
      `engine-core.ts`, with event sequences and exit codes matching the baseline.
- [ ] `grep -E "blueprint|goal|verification|trigger|preAgent|postAgent"
      src/core/engine-core.ts src/core/pipeline.ts` returns no matches.
- [ ] `pnpm vitest run` and `pnpm biome check` stay green.
