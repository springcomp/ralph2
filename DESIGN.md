# Ralph architecture

Ralph is a deterministic AI coding-loop orchestrator. Each iteration selects one
unchecked task, runs an AI harness, executes deterministic gates, and either
continues, remediates, blocks, or completes. The implementation is deliberately
split into three layers:

```text
surface DTOs  ->  lowering/compiler  ->  CorePlan interpreter
(YAML/CLI)         (desugaring)          (lock/source/pipeline/guards)
```

The surface contract remains user-friendly and stable. The core has no knowledge
of YAML workflow names or positional stage buckets.

## 1. Surface layer

The surface layer is implemented by `src/config/schema-v1.ts`,
`src/config/validator.ts`, the CLI in `src/cli/`, and the templates used by
`ralph init`.

Configuration keeps the familiar vocabulary:

```yaml
workspace: .
tasks:
  prd: .agentic/PRD.md
  progress: .agentic/progress.txt
  prompt: .agentic/ralph.prompt.md
defaults:
  harness: copilot
harnesses:
  copilot:
    executable: copilot
    arguments: ["--prompt", "{PROMPT}"]
preAgent: []
postAgent: []
verification:
  requireTaskChecked: true
  retries: 1
continuation:
  kind: blueprint
trigger:
  kind: taskAppears
circuitBreaker:
  checks:
    - kind: noProgress
      threshold: 5
```

`preAgent`, `harness`, `postAgent`, and verification retain their public
positional meaning. Blueprint and goal continuations, triggers, circuit
breakers, placeholders, environment files, timeouts, safe argv execution, and
CLI flags are also surface features. Validation reports YAML paths and rejects
unknown or malformed values before execution.

The CLI supports `run`, `schema`, `init`, and extension introspection commands:
`templates`, `variables`/`vars`, `actions`, `predicates`, `triggers`, and
`explain`. Exit codes are stable: `0` complete, `2` invalid configuration,
`3` blocked, `4` iteration limit, and `5` process failure or cancellation.

## 2. Lowering layer

`src/config/compiler.ts` first validates and resolves the surface document into
stage plans. `compileCore()` then lowers those plans into the core vocabulary.
Lowering is compile-time composition; runtime core code does not branch on
surface feature names.

| Surface configuration | Core representation |
| --- | --- |
| `preAgent`, selected harness, `postAgent` | One flat `Step[]`, tagged `pre`, `harness`, or `post` |
| Bucket failure defaults | A step `Policy` (`stop`, `continue`, `retry`, or `schedule`) |
| `onFailure` action/task | `Policy.schedule(action, maxAttempts)` |
| `verification` | A synthesized `verify` step using the selected harness and a task-checked retry predicate |
| Blueprint continuation | A chained PRD source and blueprint refill source |
| Goal continuation | A generator source with `afterTask` producer and completion predicate |
| `trigger` | A work source wrapper that waits after inner exhaustion |
| `circuitBreaker.checks` | `Guard[]` with persisted streak evaluation |

The lowering modules are `src/config/lowering/steps.ts` and
`src/config/lowering/worksource.ts`. The compiler reuses existing stage
execution, placeholder, environment, artifact, and extension implementations.
`compileCore()` returns `CorePlan`; the legacy DTO compiler remains available
where compatibility tests and lowering need the resolved `WorkflowPlan`.

Extensions are registered through `src/extensions/registry.ts`. Continuation,
trigger, and circuit-breaker registrations can provide `lower()` hooks as well
as runtime callbacks. Adding a kind therefore extends the frontend without
adding feature branches to the core interpreter.

## 3. Core layer

The core vocabulary is defined in `src/core/plan.ts`:

```ts
interface CorePlan {
  workspace: string;
  maxIterations: number;
  source: WorkSource;
  steps: Step[];
  guards: Guard[];
  status(ctx: CoreContext): string;
}
```

`Step.run(ctx)` returns a `StepResult` and carries one failure `Policy`.
`WorkSource.pull(iteration)` returns the next task or `null`; composed sources
handle PRD tasks, continuation, and optional trigger waiting. Its optional
`afterTask(ctx)` hook performs goal production after a successful iteration.
`Guard.signature(ctx)` returns a persisted-progress signature or `null`.

`src/core/pipeline.ts` is the uniform step interpreter. It applies retry,
continue, schedule, and stop policies and returns one `Outcome` shape. It emits
the existing stage events and never exposes the old failure-handling union.

`src/core/engine-core.ts` is the runtime loop:

```text
acquire workspace lock
for iteration = 1..maxIterations:
  abort?                         -> canceled
  task = source.pull(iteration)  -> complete/blocked when exhausted
  build context and emit status
  outcome = pipeline.run(steps)
  terminal outcome?              -> return it
  evaluate guards                -> blocked when a guard trips
  source.afterTask?(context)
return iteration limit
```

The engine owns only locking, cancellation, iteration limits, event/status
callbacks, and guard evaluation. It delegates work selection to `WorkSource`
and step behavior to the pipeline. Event names and exit-code behavior remain
compatible with the surface contract.

### Work sources and triggers

`PrdSource` reads the first unchecked Markdown task. `BlueprintRefill` seeds
another task when the PRD is empty, while `ChainedWorkSource` composes sources.
`GeneratorWorkSource` runs a producer and evaluates a goal predicate after each
task. `TriggerWorkSource` waits only after the composed inner source is
exhausted; a trigger signal resumes the loop, `null` completes, and cancellation
ends the run as canceled.

The built-in `taskAppears` trigger polls a Markdown source. Checked task lines
act as the idempotency cursor, so a drained batch does not wake the loop again.

### Circuit breakers

Circuit breakers are generic guards persisted in
`.agentic/__circuit_breaker.json`. A `null` signature resets a streak, an equal
signature increments it, and a changed signature starts a new streak. Reaching
the configured threshold blocks the run. Built-ins are `noProgress` (jj or git)
and `repeatedFailureSignature`; custom checks use the same signature callback.

### Process and state safety

`src/core/process-runner.ts` launches commands with `shell: false`, streams
output, supports PTY mode, redacts secrets, and terminates process trees on
timeout or cancellation. Markdown mutations and circuit-breaker state use
atomic writes and workspace/state locks.

## Verification and quality gates

Run the existing gates from the repository root:

```text
pnpm vitest run
pnpm biome check
pnpm typecheck
```

Coverage is enforced by the repository's V8 coverage gate and must not regress.
The two sample configurations under `samples/` are smoke-tested through the
bootstrapped CLI. Integration fixtures cover blueprint, goal, trigger,
remediation, verification retry, and circuit-breaker parity.
