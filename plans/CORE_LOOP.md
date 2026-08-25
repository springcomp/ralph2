# Plan: Collapse Ralph core to a tiny interpreter

## Goal

Re-architect the innards only. Shrink `WorkflowEngine` (~900 lines today) to a tiny,
obvious loop over a minimal IR — `CorePlan` = `steps[]` + `WorkSource` + `Guard[]`.
Lift everything that is *not* the loop (positional buckets, verification, blueprint/goal
continuation, trigger, remediation, circuit breaker) up into the **compiler (lowering)**
or into the `WorkSource` / `Policy` / `Guard` abstractions.

> Saint-Exupéry: perfection is reached not when there's nothing left to add, but when
> there's nothing left to remove. The removal here is special-case branches on the hot
> path — replaced by uniform composition of a small vocabulary.

## Frozen — MUST NOT change (public contract)

- Surface YAML: `schema-v1` DTOs, positional buckets (`preAgent` / `harness` /
  `postAgent` / `verification`), continuation `blueprint` / `goal` shapes, `trigger:`,
  `circuitBreaker:`, templates, `ralph init`.
- Event protocol (`ralph.event type=... iteration=... stage=... message=...`) and every
  event type currently emitted.
- Exit codes (`0/2/3/4/5`) and their triggering conditions.
- CLI flags and introspection commands (`ralph templates|actions|predicates|triggers|
  explain ...`).
- Behavioral parity is proven by the **unchanged** integration fixtures
  (goal / blueprint / trigger / circuit-breaker).

Distinct surface vocabulary stays for user-friendliness; it desugars to one core
abstraction. Blueprint YAML still looks like blueprint; buckets still look like buckets.

## Target core vocabulary (new `src/core/plan.ts`)

```ts
interface Step {
  run(ctx): Promise<StepResult>;                 // wraps executable/args/env/pty/exit-codes
  onFail: Policy;                                 // stop | continue | retry | schedule
  role: "pre" | "harness" | "post" | "verify";    // events/diagnostics only, never branched on
  name: string;                                   // "build", "test" — telemetry unchanged
}

type Policy =
  | { kind: "stop" }
  | { kind: "continue" }
  | { kind: "retry"; predicate: Predicate; times: number }
  | { kind: "schedule"; action: string; maxAttempts: number };

interface WorkSource {
  pull(iteration): Promise<Task | null>;          // null = done; may block (trigger)
  afterTask?(ctx): Promise<void>;                 // goal producer/predicate hook
}

interface Guard { kind: string; threshold: number; signature(ctx): Promise<string | null>; }
interface Predicate { check(ctx): Promise<boolean>; }

interface CorePlan {
  workspace: string;
  maxIterations: number;
  source: WorkSource;                             // prd + continuation + trigger, pre-composed
  steps: Step[];                                  // pre + harness + post + verify, flat
  guards: Guard[];                                // circuit-breaker checks
  status(ctx): string;
}
```

The engine sees **only** `CorePlan`. Success test: `grep -E
"blueprint|goal|verification|trigger|preAgent|postAgent" src/core/engine*.ts` is empty
after cutover.

## Target engine loop (~40 lines, replaces `WorkflowEngine.run`)

```
lock.acquire()
for i in 1..maxIterations:
  if aborted            -> canceled
  task = await source.pull(i)          // handles seed / continuation / trigger internally
  if !task              -> complete
  ctx = values(task, i)                // placeholder context, existing builder reused
  emit task.started + status
  outcome = await pipeline.run(steps, ctx, i)     // applies Policy per step, uniformly
  if outcome.terminal   -> return outcome         // blocked | processFailure | canceled
  if await guards.trip(i, outcome.lastFailure) -> blocked
  await source.afterTask?(ctx)         // goal: run producer, eval completeWhen
return iterationLimit
```

Core holds only: lock, iteration cap, abort, guard. Two collaborators: `source.pull()`
and `pipeline.run()`.

## Lowering rules (compiler; reuse existing DTO parsing in `compiler.ts` `stage()`)

| Surface sugar (frozen) | Lowers to |
| --- | --- |
| `preAgent` / `harness` / `postAgent` | one flat `steps[]`; each step tagged `role`; harness selected via `--harness` |
| bucket default failure behavior | baked into per-step `Policy` — pre/harness/post = `stop`, verify = `retry` |
| `onFailure.action` / `task` + `maxRemediationAttempts` | `Policy.schedule(action, maxAttempts)` |
| `failurePolicy: continue` / `mandatory: false` | `Policy.continue` |
| `verification.requireTaskChecked` + `retries` | synthesized `verify` step cloning selected harness (swapped temp prompt) with `Policy.retry(taskUnchecked, retries)`; emit none when `requireTaskChecked: false` |
| `continuation.blueprint` (`seedPrdFromSource`) | `ChainedWorkSource([PrdSource, BlueprintRefill])`; exhaustion → `completeWhenSourceExhausted` decides complete vs blocked |
| `continuation.goal` (`producer` + `nextTask` + `completeWhen`) | `GeneratorWorkSource` with `afterTask`: run producer, eval `completeWhen` predicate (complete) else `scheduleTask(nextTask)` |
| `trigger` | `TriggerWorkSource` wrapping the composed source: inner `null` → await trigger → fired=continue / null=done / aborted=canceled |
| `circuitBreaker.checks` | `Guard[]`, reusing `evaluateCircuitBreaker` + state persistence unchanged |

Two hard collapses:

- **Two completion mechanisms → one.** `goal.completeWhen` and blueprint "exhausted"
  both become `WorkSource.pull()` returning `null`. Core has one completion concept.
- **Buckets → one flat list.** The only real difference between buckets is default
  Policy, chosen at compile time, invisible to core. `role` survives for events only.

## Phases (suite stays green throughout)

### Phase 0 — Baseline safety net
- Run full vitest; capture green baseline.
- Add golden tests where coverage is thin, to lock behavior across the refactor:
  verification retry (success + exhaust), remediation depth cap, trigger
  idle→fire→resume, circuit-breaker trip after N.

### Phase 1 — Core vocabulary types (additive, zero behavior change)
- New `src/core/plan.ts`: `CorePlan` / `Step` / `Policy` / `WorkSource` / `Guard` /
  `Predicate` / `Outcome`.

### Phase 2 — Compiler lowering (build `CorePlan` alongside existing `WorkflowPlan`)
- New `src/config/lowering/steps.ts` — buckets → `steps[]` + Policy + verify step.
- New `src/config/lowering/worksource.ts` — `PrdSource`, `BlueprintRefill` / `Chained`,
  `GoalGenerator`, `TriggerWorkSource`.
- `compiler.ts` gains `compileCore(): CorePlan`; keeps emitting the fat plan too (no
  cutover yet).

### Phase 3 — New tiny engine over `CorePlan`
- New `src/core/pipeline.ts` — `run(steps, ctx, i)` applying `Policy`; replaces the leaky
  `handleFailure` union return (`WorkflowRunResult | "scheduled" | null`) with an
  `Outcome` type.
- New engine (parallel `src/core/engine-core.ts`) — the ~40-line loop. Emits identical
  events and exit codes. Validate against Phase 0 goldens driven by `CorePlan`.

### Phase 4 — Cutover
- Point `src/cli/index.ts` + engine construction at `compileCore` + the new engine.
- Delete dead fat-plan machinery: `handleFailure`, `continueWhenEmpty`,
  `continueAfterTask`, `awaitTrigger`, inline `runCircuitBreakers`, inline verification
  loop; and fat `WorkflowPlan` fields (`preAgent` / `postAgent` / `verification` /
  `continuation` / `harnesses` / `trigger` / `circuitBreaker`) once unread. Keep
  `StagePlan` (reused by `Step.run`).

### Phase 5 — Extensibility hook (build-on-top)
- Registry gains a lowering hook per kind: each continuation strategy / trigger / breaker
  registers a `lower()` + YAML fragment beside its runtime callback. Adding a kind never
  edits core.

```ts
interface ContinuationLowering {
  name: string;                    // "blueprint" | "goal"
  schema: DtoFragment;             // friendly YAML shape (surface)
  lower(dto, ctx): WorkSource;     // frontend → IR
}
```

### Phase 6 — Docs + cleanup
- Rewrite `DESIGN.md` around the three layers (surface / lowering / core) — separate
  approved outline.
- Full suite + coverage + biome green.

## Relevant files

- `src/core/engine.ts` — `WorkflowEngine.run` + `handleFailure` / `continueWhenEmpty` /
  `continueAfterTask` / `awaitTrigger` / `runCircuitBreakers` / `runStage` / `values`:
  the source of everything to collapse.
- `src/config/compiler.ts` — `stage()` / `compile` + fat `WorkflowPlan` / `StagePlan`:
  add `compileCore` + lowering. `StagePlan` stays (reused by `Step.run`).
- `src/config/schema-v1.ts`, `src/config/validator.ts` — surface DTOs: **frozen**, no
  semantic change.
- `src/extensions/registry.ts`, `src/extensions/types.ts` — add lowering hook; keep
  runtime callbacks.
- `src/extensions/{producers,triggers,circuit-breakers,predicates,actions}` — reused by
  lowering.
- `src/core/circuit-breaker.ts` — `evaluateCircuitBreaker` reused as the Guard engine
  (unchanged).
- `src/core/task.ts` (`TaskSource`) + markdown task source — reused inside `WorkSource`
  implementations.
- `src/cli/index.ts` — cutover point.
- Contract tests: `tests/integration/{goal,blueprint}-workflow.test.ts`,
  `tests/core/{engine,trigger,circuit-breaker}.test.ts`, `tests/config/compiler.test.ts`.

## Verification

1. `pnpm vitest run` green at the Phase 0 baseline and after every phase (especially
   integration).
2. New golden tests (Phase 0) stay green through cutover — the parity proof.
3. `grep -E "blueprint|goal|verification|trigger|preAgent|postAgent" src/core/engine*.ts`
   → empty after Phase 4.
4. `samples/*/ralph.yaml` run unchanged via `bootstrap/ralph.js`.
5. Event-stream snapshot for a sample run identical pre/post (telemetry contract).
6. `pnpm biome check` clean; coverage not decreased (`coverage.json` gate).

## Decisions (locked)

- **Parallel-then-swap.** Build the new engine as `src/core/engine-core.ts` beside the
  existing `engine.ts`; cut over in Phase 4 and delete the old one only once green.
  Safer diff, easy rollback.
- **`pull()` stays pure.** `WorkSource.pull(iteration)` only yields the next task or
  `null` — no side effects. The goal continuation's producer/predicate (today
  `continueAfterTask`) runs in the explicit `WorkSource.afterTask(ctx)` hook, called by
  the engine after a successful iteration. Blueprint seeding likewise happens inside
  `pull()` as a pure "what's next" decision, not a mutation leaking to the loop.
- **Keep multi-harness.** The `harnesses` map + `--harness` selection stays; lowering
  resolves the selected harness and places it as the single `role: "harness"` step in
  `steps[]`. The synthesized `verify` step clones that same resolved harness.

## Remaining detail

- Verification temp-prompt file writing stays (behavior); moves into verify-step lowering
  / run.
