# TASK-005 - Phase 4: Cutover to the core engine

## Context

Ref: [plans/CORE_LOOP.md](../plans/CORE_LOOP.md) — Phase 4.

Switch the CLI to the new engine and delete the now-dead fat-plan machinery.

## Implementation steps

1. Point `src/cli/index.ts` (and any other engine construction site) at `compileCore()`
   and `engine-core.ts` instead of `compile()` / `WorkflowEngine`.
2. Run the full suite; fix any behavioral gaps surfaced by real CLI usage (samples,
   integration tests) rather than by special-casing the new engine.
3. Once green, delete dead code from the old fat-plan path:
   - `handleFailure`, `continueWhenEmpty`, `continueAfterTask`, `awaitTrigger`, inline
     `runCircuitBreakers`, inline verification loop in `src/core/engine.ts`.
   - Fat `WorkflowPlan` fields (`preAgent`, `postAgent`, `verification`,
     `continuation`, `harnesses`, `trigger`, `circuitBreaker`) once no longer read
     anywhere.
   - Keep `StagePlan` (still reused by `Step.run`).
4. Rename/replace `src/core/engine-core.ts` → the canonical engine entry point if the
   plan calls for dropping the `-core` suffix once the old engine is deleted (only after
   confirming no remaining references to the old `WorkflowEngine`).
5. Update any CLI introspection commands (`ralph templates|actions|predicates|
   triggers|explain ...`) that referenced fat-plan internals to use `CorePlan`
   equivalents, preserving output format.

## Acceptance criteria

- [ ] `src/cli/index.ts` constructs and runs the workflow via `compileCore()` +
      the core engine exclusively.
- [ ] Dead fat-plan code and unread `WorkflowPlan` fields listed above are removed.
- [ ] `samples/blueprint/ralph.yaml` and `samples/goal/ralph.yaml` run unchanged via
      `bootstrap/ralph.js` (manual or scripted smoke run).
- [ ] CLI flags and introspection commands (`ralph templates|actions|predicates|
      triggers|explain ...`) still work and produce unchanged output.
- [ ] Exit codes (`0/2/3/4/5`) and event protocol remain exactly as before.
- [ ] `pnpm vitest run` and `pnpm biome check` are green; coverage not decreased versus
      the `coverage/coverage-summary.json` baseline.
