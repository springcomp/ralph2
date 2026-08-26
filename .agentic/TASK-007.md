# TASK-007 — Add configuration, placeholder, core, and template regression tests

## Objective
Prove compatibility boundaries and new task ownership invariants at unit/component level.

## Implementation
1. Update `tests/config/validator.test.ts` for queue-only, PRD-only compatibility, equal aliases, conflicting aliases, goal path, and completion enum cases.
2. Update `tests/config/compiler.test.ts` for canonical resolution, trigger default, completion lowering, and goal path.
3. Update `tests/placeholders/placeholders.test.ts` for `{QUEUE}`, `{GOAL}`, and `{PRD}` alias expansion.
4. Update `tests/config/lowering.test.ts`, task-source tests, and related fixtures to canonical queue terminology while retaining queue ordering/refill/idempotency coverage.
5. Add engine/pipeline tests for engine-owned completion ordering and all non-success paths.
6. Add lowering tests for generated harness prompt contents, unchanged source prompt, and independent verification prompt.
7. Update `tests/extensions/registry.test.ts` and `tests/cli/index.test.ts` for new goal files/config and migrated blueprint queue artifacts.

## Acceptance criteria
- Legacy path behavior has explicit tests rather than accidental coverage.
- Every completion state transition path has deterministic assertion.
- Prompt assignment behavior has direct test coverage.
- Template/CLI tests assert GOAL plus queue outputs and absence of goal PRD output.
- Existing blueprint behavior remains covered after terminology migration.
