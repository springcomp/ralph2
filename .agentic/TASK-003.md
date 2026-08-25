# TASK-003 - Phase 2: Compiler lowering to CorePlan

## Context

Ref: [plans/CORE_LOOP.md](../plans/CORE_LOOP.md) — Phase 2 and the "Lowering rules"
table.

Build a `CorePlan` alongside the existing fat `WorkflowPlan`, without cutting over yet.
`compiler.ts` keeps emitting the fat plan; a new `compileCore()` additionally produces
the lean IR.

## Implementation steps

1. Create `src/config/lowering/steps.ts`:
   - Flatten `preAgent` / `harness` (selected via `--harness`) / `postAgent` into a
     single `steps: Step[]`, tagging each with its `role`.
   - Bake default `Policy` per bucket: pre/harness/post → `stop` (or `continue` when
     `failurePolicy: continue` / `mandatory: false` is set); remediation
     (`onFailure.action` + `maxRemediationAttempts`) → `Policy.schedule`.
   - Synthesize the `verify` step from `verification.requireTaskChecked` +
     `retries`: clone the resolved harness with a swapped temp prompt, `Policy.retry`
     against a `taskUnchecked` predicate. Emit no verify step when
     `requireTaskChecked: false`.
2. Create `src/config/lowering/worksource.ts`:
   - `PrdSource` + `BlueprintRefill` composed into a `ChainedWorkSource` for
     `continuation.blueprint` (`seedPrdFromSource`); exhaustion resolved via
     `completeWhenSourceExhausted` (complete vs blocked).
   - `GeneratorWorkSource` for `continuation.goal`: `afterTask` runs the producer, then
     evaluates `completeWhen`; if not complete, calls `scheduleTask(nextTask)`.
   - `TriggerWorkSource` wrapping the composed source per the frozen semantics: inner
     `null` → await trigger → fired resumes, `null` from trigger → done, aborted →
     `canceled`.
3. Add `compileCore(): CorePlan` to `src/config/compiler.ts`, reusing existing DTO
   parsing (`stage()`) and keeping `StagePlan` (reused by `Step.run`). Keep emitting the
   existing `WorkflowPlan` unchanged — this is additive only.
4. Wire circuit breaker lowering: `circuitBreaker.checks` → `Guard[]`, reusing
   `evaluateCircuitBreaker` and its state persistence unchanged.
5. Unit test each lowering module in isolation
   (`tests/config/lowering/steps.test.ts`, `tests/config/lowering/worksource.test.ts`)
   plus a `compileCore` test in `tests/config/compiler.test.ts` covering: bucket
   flattening + policy defaults, verify-step synthesis (present/absent), blueprint
   continuation lowering, goal continuation lowering, trigger wrapping, circuit-breaker
   guard lowering.

## Acceptance criteria

- [ ] `compileCore()` exists and returns a valid `CorePlan` for each sample config in
      `samples/blueprint/ralph.yaml` and `samples/goal/ralph.yaml`.
- [ ] Existing `compile()` / `WorkflowPlan` output is byte-for-byte unchanged (no
      regression in `tests/config/compiler.test.ts` existing cases).
- [ ] New lowering unit tests pass for all rows in the Phase 2 lowering table.
- [ ] `pnpm vitest run` and `pnpm biome check` stay green.
- [ ] No behavior change: nothing yet consumes `compileCore()` at runtime.
