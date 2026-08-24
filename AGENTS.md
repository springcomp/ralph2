# Ralph

This is `ralph`, a CLI AI-coding harness runner that runs deterministic gates to implement
a self-correcting Ralph Loop. As its core, it’s a pipeline runner:

> `preAgent` → `harness` → `postAgent` → `verification` → `continuation`
> loop the pipeline while a task-source yields work, until a completion-predicate fires.

Currently supports:

- `goal` workflow: loops until a goal is met.
- `blueprint` workflow: iterate over a sequence of checkable tasks.
- `trigger` (optional): idle until an external signal fires, then run the workflow,
  returning to idle when work is exhausted. See `DESIGN.md` (WorkSource / triggers).
- `circuitBreaker` (optional): blocks the run when a registered check's signature
  repeats for `threshold` consecutive iterations (e.g. no VCS progress, or the same
  gate failing every time) — a safety net independent of `maxIterations`, since
  triggers make that cap unreliable for long-lived watchers. See `DESIGN.md`.

Which are two instances of `(source, predicate)` pairs.

- Task source: `goal` generates its next task ( producer  +  nextTask ); `blueprint` pulls it from a file ( `seedBlueprintTask` ).
- Completion predicate: `goal` uses  `completeWhen` ; `blueprint` uses "source exhausted."
