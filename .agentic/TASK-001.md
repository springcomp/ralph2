# TASK-001 - Phase 0: Baseline safety net

## Context

Ref: [plans/CORE_LOOP.md](../plans/CORE_LOOP.md) — Phase 0.

Before touching `WorkflowEngine`, lock down current behavior with a green baseline and
close any coverage gaps on the paths the refactor will move (verification retries,
remediation scheduling, trigger idle/fire/resume, circuit-breaker trip).

## Implementation steps

1. Run `pnpm vitest run` and `pnpm biome check`; record the baseline as green (or fix
   pre-existing failures first, out of scope for this refactor otherwise).
2. Audit existing coverage in [tests/core/engine.test.ts](../tests/core/engine.test.ts),
   [tests/core/trigger.test.ts](../tests/core/trigger.test.ts),
   [tests/core/circuit-breaker.test.ts](../tests/core/circuit-breaker.test.ts), and
   [tests/integration](../tests/integration) for:
   - Verification retry: succeeds within retry budget, and exhausts retries → `blocked`.
   - Remediation (`onFailure.action` + `maxRemediationAttempts`): depth cap is enforced
     and emits the expected events/exit code when exceeded.
   - Trigger: idle → fires → resumes pipeline, and idle → aborted → `canceled`.
   - Circuit breaker: trips to `blocked` after N repeated identical signatures.
3. Add any missing "golden" tests above as new test cases (do not change production
   code in this task). Capture exact event sequences / exit codes emitted today so they
   can be diffed against post-refactor behavior.

## Acceptance criteria

- [ ] `pnpm vitest run` is green, including newly added golden tests.
- [ ] `pnpm biome check` is clean.
- [ ] Golden tests exist and pass for: verification retry success, verification retry
      exhaustion, remediation depth cap, trigger idle→fire→resume, trigger
      idle→abort→canceled, circuit-breaker trip after N iterations.
- [ ] No production code under `src/` is modified in this task.
