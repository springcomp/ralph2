# TASK-008 — Update integration tests and run full verification

## Objective
Prove end-to-end goal behavior with empty queue and engine completion, preserve blueprint watcher behavior, then execute repository gates.

## Implementation
1. Replace or rename `tests/integration/goal-empty-prd.test.ts` as queue-focused integration coverage:
   - start with empty `queue.md`;
   - verify first seed appears;
   - verify fake harness reads generated assigned-task prompt;
   - do not have harness check task;
   - verify engine checks task before producer completion;
   - verify no second seed occurs.
2. Update `tests/integration/blueprint-watcher.test.ts` fixture/config naming to queue and verify refill/watcher behavior is unchanged.
3. Run targeted affected Vitest suites while implementing.
4. Run repository gates from root:
   - `pnpm vitest run`
   - `pnpm biome check`
   - `pnpm typecheck`
5. Perform manual smoke tests for goal init, legacy PRD config, and blueprint refill/watcher if automated integration gaps remain.

## Acceptance criteria
- Goal integration passes without agent queue mutation.
- Blueprint watcher integration passes using canonical queue path.
- Full test, lint/format, and typecheck gates pass.
- Goal init produces GOAL/queue artifacts and generated assignment prompt behavior is observable.
- Minimal legacy `tasks.prd` workflow still runs and `{PRD}` resolves to its queue.
