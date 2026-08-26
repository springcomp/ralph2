# TASK-002 - Seed an initial generated goal on the first pull

## Objective

Change `GeneratorWorkSource` so an empty PRD can receive a configured literal seed task before the workflow exits, while preserving normal generated-goal behavior.

## Implementation steps

1. Extend the `GeneratorWorkSource` constructor with optional `seedTask` input.
2. Add per-instance initialization state so initial seeding can happen at most once in a workflow run.
3. In `pull(iteration)`, call the wrapped base source first.
4. If the first pull has no task and a seed task is configured, call `TaskSource.scheduleTask(plan.tasks.prd, seedTask)`.
5. Pull the base source again and return the seeded task.
6. Restrict this behavior to the initial workflow pull/iteration; do not reseed after a completed initial task leaves the PRD empty.
7. Use the seed string exactly as configured. Do not call the runtime placeholder expander for `seedTask`.
8. Leave `afterTask` unchanged: run the producer, evaluate `completeWhen`, and schedule expanded `nextTask` only when completion is false.
9. Make sure a missing `seedTask` retains the existing empty-PRD completion behavior.
10. Pass `seedTask` from `generatedGoalContinuationLowering` into the source constructor.

## Acceptance criteria

- [x] Empty PRD plus configured `seedTask` causes exactly one schedule operation on the initial pull.
- [x] The initial pull returns the task made available by that schedule operation.
- [x] A non-empty PRD is returned without a seed write.
- [x] A missing `seedTask` does not alter current behavior.
- [x] A later empty pull after initial processing does not reseed during the same workflow run.
- [x] Initial seeding does not run the producer or completion predicate.
- [x] Existing post-task `nextTask` expansion remains unchanged.

## Tests

- [x] Add focused `GeneratorWorkSource` tests using mocked `TaskSource` methods.
- [x] Test empty, non-empty, missing-seed, and no-reseed cases.
- [x] Test that the literal seed is passed unchanged and `afterTask` still expands `nextTask`.
