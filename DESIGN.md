# Ralph TypeScript Architecture & Technical Design

## Overview

Ralph is a deterministic AI coding loop orchestrator. It executes an AI coding harness in an iterative loop with a fresh context window per iteration. Between agent invocations, Ralph executes deterministic checks (build, test, coverage, lint) and can automatically schedule immediate remediation tasks (`FIX-xxx`) or seed follow-up tasks from a blueprint.

The TypeScript port (`ralph`) replicates all behaviors, exit codes, locks, and schema definitions of the C# MVP with idiomatic modern TypeScript, Commander.js, Biome, and Vitest.

---

## High-Level Architecture

```
                      +-----------------------------+
                      |          CLI Entry          |
                      | (ralph run, validate, init) |
                      +--------------+--------------+
                                     |
                                     v
                      +-----------------------------+
                      |   Configuration & Schema    |
                      |   - V1 Workflow DTOs        |
                      |   - Path-based Diagnostics  |
                      |   - Workflow Compiler       |
                      +--------------+--------------+
                                     |
                                     v
                      +-----------------------------+
                      |       Workflow Engine       |
                      +---+---------------------+---+
                          |                     |
                          v                     v
          +-----------------------+     +-----------------------+
          |  Markdown Task Source |     |    Process Runner     |
          |  - PRD parser         |     |  - Safe argv launch   |
          |  - Blueprint seeder   |     |  - Tree cancellation  |
          |  - State locks (CAS)  |     |  - Secret redaction   |
          |  - Workspace lock     |     |  - Timeout handling   |
          +-----------------------+     +-----------------------+
```

---

## Core Components

### 1. Placeholder Engine (`src/core/placeholders.ts`)

Ralph performs variable expansion on command executables, argument lists, environment variable values, output paths, and prompt templates.

#### Supported Placeholders

| Placeholder | Value / Source |
| --- | --- |
| `{MODEL}` | Resolved AI model name (task metadata > CLI `--model` > config default) |
| `{AGENT}` | Resolved agent selector (task metadata > CLI `--agent` > config default) |
| `{TYP}` | Task type prefix (e.g., `T`, `FIX`, `TASK`, `QT3`) |
| `{NUM}` | Task numerical identifier (e.g., `001`) |
| `{TASK}` | Task description without inline metadata tags |
| `{TASK_LINE}` | Verbatim Markdown task line |
| `{ROOT}` | Root task TYP-NUM id in remediation chain (self when not remediation) |
| `{PROMPT}` | Path to prompt file (or temporary verification prompt during retry) |
| `{PRD}` | Resolved absolute or relative path to PRD Markdown file |
| `{PROGRESS}` | Resolved path to progress notes file |
| `{ITERATION}` | Current iteration index (1-based integer string) |
| `{ITERATION:000}` | Current iteration index zero-padded to 3 digits (e.g., `001`) |
| `{WORKSPACE}` | Workspace root directory path |

#### Expansion Rules

- Placeholders inside `arguments` are expanded per-item. No shell concatenation or string splitting occurs.
- `conditionalArguments`: Appends argument groups only when the placeholder specified in `whenSet` resolves to a non-empty string.
- Unknown placeholders trigger validation failure before execution begins.

#### Environment Variables

The workflow root and each command may define `envFile` and inline `environment` entries.
The single env file path is resolved relative to the workspace and uses compose-style
`KEY=VALUE` syntax. Runtime precedence is global file, global inline, stage file, then
stage inline; later values override earlier ones.

---

### 2. Markdown Task Source & Concurrency Locks (`src/core/task-source.ts`, `src/core/locks.ts`)

#### Task Format

Tasks in `PRD.md` and `BLUEPRINT.md` adhere strictly to:

```markdown
- [ ] TYP-NUM - Task description (model: `model-name`) (agent: `agent-name`)
```

- `TYP` starts with an ASCII letter, followed by alphanumeric characters.
- `NUM` is numeric.
- Inline metadata `(model: \`...\`)` and `(agent: \`...\`)` are extracted and stripped from `{TASK}`.
- Duplicate metadata keys on a single task line are rejected.

#### Task Lifecycle Operations

- **`getFirstUncheckedTask()`**: Finds the first `- [ ]` task in PRD.
- **`checkTask(task)`**: Converts the task line to `- [x]` in PRD using atomic CAS.
- **`scheduleTask(taskLine)`**: Inserts a new task (e.g. `FIX-001`) immediately before the first unchecked task. If a task with identical `TYP-NUM` already exists unchecked, it is replaced.
- **`seedFromBlueprint()`**: When PRD has no unchecked tasks and `seedPrdFromSource` is enabled, copies the first unchecked blueprint task into PRD and marks it checked in the blueprint source.

#### Locking Mechanisms

1. **Workspace Lock (`<workspace>/.agentic/.ralph.lock`)**:
   - Acquired exclusively at workflow startup.
   - Contains PID, hostname, and ISO timestamp.
   - If lock is held by an active process, Ralph exits with code `3` (Blocked).
2. **Markdown State Lock (`<file>.ralph-state.lock`)**:
   - Placed beside mutated Markdown files during CAS write operations.
   - Prevents concurrent mutation race conditions.

---

### 3. Safe Process Runner (`src/core/process-runner.ts`)

#### Safety & Process Control

- **Safe Argv**: Invokes binaries using `child_process.spawn` with `shell: false`. Arguments are never concatenated into a raw shell string.
- **Process Tree Killing**: On timeout or cancellation (SIGINT/SIGTERM), kills the entire process tree (`tree-kill` or native process group signal) to prevent orphaned background processes.
- **Secret Redaction**: Any environment variable defined with `secret: true` has its expanded value redacted from logs, stdout, and error traces.
- **Output Streaming**: Streams stdout/stderr to configured combined output log (`output.combined`) with parent directory creation.

---

### 4. Configuration Loader & Schema Validator (`src/config/`)

#### Schema V1 Specification

Validates YAML against the Ralph V1 Schema:

- Deserializes into typed DTOs.
- Validates field shapes and reports exact YAML paths in diagnostics (e.g., `postAgent[0].arguments[2]`).
- Compiles relative paths against `workspace` root.

#### Diagnostic Codes & Exit Codes

- Valid configuration: Exit `0`.
- Validation error: Exit `2` with path-annotated diagnostic errors.

#### Streaming stdout / stderr back to console

The user MUST see the inner processes’ stdout / stderr in real time,
include ANSI colors and Unicode encodings. Use a pseudo TTY if needed.

Implemented via `@lydell/node-pty`: `RealProcessRunner` allocates a pseudo-terminal for the
child process instead of plain pipes, which preserves ANSI escape sequences that would
otherwise be stripped by the child's own color-detection logic. Because a real terminal merges
stdout and stderr into a single stream, PTY-mode output is reported to `onOutput` as `"stdout"`.

- **Enablement**: auto-detected from Ralph's own `process.stdout.isTTY`, overridable per
  command/harness (`pty: true|false` in YAML) and globally via `--pty` / `--no-pty` CLI flags.
  Precedence: per-command config > CLI flag > auto-detect.
- **Fallback**: if the pty module fails to load or fails to allocate a terminal (e.g. an
  unsupported platform/arch), `RealProcessRunner` transparently falls back to the existing
  piped `child_process.spawn` path.

---

### 5. Workflow Engine (`src/core/engine.ts`)

#### Execution Lifecycle per Iteration

```
[Start Iteration]
       |
       v
[Workspace Lock Verified]
       |
       v
[Seed PRD from Blueprint if PRD empty]
       |
       v
[Read First Unchecked PRD Task] ---> None remaining? ---> [Check Continuation / Complete]
       |
       v
[Resolve Model / Agent / Harness]
       |
       v
[Emit Status: "Iteration 001 - T-001 - ..."]
       |
       v
[Execute preAgent Stages] (Failure -> onFailure action / Stop)
       |
       v
[Execute Selected Harness] (e.g. Copilot / Pi)
       |
       v
[Re-read PRD State]
       |
       v
[Execute postAgent Stages] (Build, Test, Coverage)
       |
  (Any failure?)
   /          \
 (Yes)        (No)
  /             \
[Schedule FIX]   [Verification Check: requireTaskChecked?]
[Stop / Cont]     |
                  +---> Task Checked? ---> [Apply Continuation (Blueprint/Goal)]
                  |
                  +---> Task Unchecked?
                            |
                     (Retries left?)
                      /          \
                    (Yes)        (No)
                     /             \
            [Run Verification]   [Exit 3: Blocked]
```

#### Event Output Protocol

Ralph emits structured events to stdout for telemetry and external tooling:

```text
ralph.event type=<type> iteration=<n> stage=<stage-or--> message=<message>
```

#### Exit Codes

| Code | Name | Description |
| ---: | --- | --- |
| `0` | `Complete` | Workflow completed successfully or validation passed |
| `2` | `InvalidConfiguration` | Invalid CLI arguments or YAML schema violations |
| `3` | `Blocked` | Workspace lock contention, ambiguous state, or verification failure |
| `4` | `IterationLimitReached` | Reached `maxIterations` without completing all work |
| `5` | `ProcessFailure` | Command execution failure, process timeout, or Ctrl+C cancellation |

---

### 5b. WorkSource Levels & Triggers (`src/extensions/triggers/`)

Ralph's loop is one pipeline (`preAgent → harness → postAgent → verification →
continuation`) fed by a stack of **work sources**, each with the same shape: *yield
work until a predicate says stop*. Exhaustion at one level bubbles to the next level
out.

| Level | Source | Yields | On exhaustion |
| --- | --- | --- | --- |
| Task | `MarkdownTaskSource.getFirstUncheckedTask` | individual tasks within a run | defer to continuation |
| Continuation | `blueprint` / `generatedGoal` | refills the task queue | defer to trigger (if configured) else terminate |
| Trigger | `taskAppears`, … | whole runs | idle, or terminate when it will never fire again |

`goal` and `blueprint` are two `continuation` strategies over the same pipeline: `goal`
*generates* its next task (`producer` + `nextTask`) and stops on `completeWhen`;
`blueprint` *pulls* the next task from a source file and stops when the source is
exhausted. Both are `(task-source, completion-predicate)` pairs.

A **trigger** is the outermost work source. It is consulted only when the workflow would
otherwise complete normally (status `complete`); it never intercepts `blocked` /
remediation / failure paths. When no `trigger` is configured, behavior is exactly as
before (fully backward compatible).

Lifecycle when a trigger is configured:

```text
compile → engine.run() iteration loop
   work exhausted → continuation would return `complete`
      trigger.wait()  ── idle ──►  fires (signal)  ──►  loop resumes (next iteration)
                                   returns null    ──►  terminate `complete`
                                   aborted         ──►  terminate `canceled`
```

`maxIterations` remains the overall safety cap across wake-ups. Each wake-up consumes
iterations, so an always-firing trigger with no new work eventually returns
`IterationLimitReached`.

#### `trigger` configuration

```yaml
trigger:
  kind: taskAppears          # any registered trigger name
  source: .agentic/BLUEPRINT.md   # observed path; defaults to tasks.prd
  pollInterval: 5s           # poll cadence; defaults to 5s
```

Built-in trigger `taskAppears` polls a Markdown source until it contains an unchecked
task, then fires. The task checkbox doubles as an idempotency cursor: drained tasks are
checked (`- [x]`), so only genuinely new, unchecked work wakes the loop — no separate
processed-offset bookkeeping required.

This satisfies the "blueprint starts empty → drain a batch of tasks one-by-one → go idle
→ wait for the next batch" pattern, and is the substrate for agent-to-agent loops: one
Ralph instance appends tasks another instance is idling on.

#### Trigger extension kind

Triggers are a first-class extension kind alongside `actions` / `predicates` /
`producers` / `templates`, registered via `createExtensionRegistry({ triggers: [...] })`
and introspectable via `ralph triggers [show]` and `ralph explain trigger <name>`. A
`TriggerRegistration.callback(context)` receives the resolved `source`,
`pollIntervalMs`, `workspace`, a shared `MarkdownTaskSource`, an `emit` callback, and an
`AbortSignal`; it resolves a `{ reason }` signal to fire, or `null` to terminate.

**Deferred (future phases, not built):** mailbox/envelope convention for directed
agent-to-agent conversation; additional trigger kinds (`watch`, `cron`, `webhook`);
cross-workspace blackboard locking.

### 5c. Circuit Breaker (`src/extensions/circuit-breakers/`, `src/core/circuit-breaker.ts`)

Triggers make `maxIterations` an unreliable backstop: a long-lived `taskAppears`-driven
watcher wants an effectively unbounded iteration budget. Without a separate safety net,
two shapes run away indefinitely:

1. A `generatedGoal` continuation whose `completeWhen` never trips true.
2. A non-mandatory gate (`mandatory: false` + `failurePolicy: continue`) that fails
   every iteration — today this only logs `"Continuing after stage failure"` and
   proceeds, forever, with no counter at all.

The **circuit breaker** closes this gap with one generic mechanism reused by any number
of pluggable checks. A check is *only* a signature function:

```ts
type CircuitBreakerCallback = (context: CircuitBreakerContext) => Promise<string | null>;
```

The engine compares each check's signature to the last one it persisted:

- `null` → reset (streak 0, check inactive this iteration — e.g. no failure occurred).
- same as last signature → streak += 1 (nothing changed / same failure recurring).
- different signature → streak = 1, update last signature (real progress, or a
  different failure).
- `streak >= threshold` → trip → the run ends `blocked` (exit code 3), naming the
  check, threshold, and repeated signature.

This is invoked **once per iteration**, immediately after the `postAgent` stage loop
finishes — before the remediation-scheduled continue and before the verification check —
so it covers both the "remediation scheduled every iteration" and the "non-mandatory
gate silently failing every iteration" shapes.

Streak/signature state is persisted to `.agentic/__circuit_breaker.json` (keyed by check
name, atomically read-modify-written under the same `StateLock` used elsewhere), so it
survives trigger idle/resume cycles *and* external process restarts.

#### Built-in checks

- **`noProgress`** — signature reflects whether the workspace's VCS state changed.
  Prefers `jj` (via `jj log --no-graph -T commit_id -r @`, which auto-snapshots the
  working copy on every invocation) when a `.jj` directory is present, since jj's
  working copy is not reliably reflected in git's `HEAD`/index without an explicit
  export — even in `jj git init --colocate` repos. Falls back to a `git rev-parse HEAD`
  + `git diff` hash when only `.git` is present. Returns `null` (inert, never errors)
  for any other/no VCS — that's the documented escape hatch for a custom check.
- **`repeatedFailureSignature`** — signature is `${stage}:${exitCode}` of the most
  recent failing `postAgent` stage this iteration, or `null` if none failed.

#### `circuitBreaker` configuration

```yaml
circuitBreaker:
  checks:
    - kind: noProgress
      threshold: 5
    - kind: repeatedFailureSignature
      threshold: 3
```

Absent `circuitBreaker:` = fully backward compatible, zero behavior change. Check kinds
are a first-class extension kind (like `trigger`), registered via
`createExtensionRegistry({ circuitBreakers: [...] })` and introspectable via
`ralph circuitBreakers [show]` / `ralph explain circuitBreaker <name>`. Custom checks
only need to implement the signature function above — streak-counting, thresholding,
and persistence are free.

**Deferred (future phases, not built):** custom trip actions beyond `blocked`; VCS
support in `noProgress` beyond git/jj (Mercurial, Perforce, SVN, etc. — register a
custom check instead).

---

## CLI Interface (`src/cli/`)

Implemented using Commander.js:

```bash
# Run workflow
ralph run --config <path> [--model <model>] [--agent <agent>] [--harness <name>] [--max-iterations <n>] [--working-directory <path>] [--plain]

# Validate workflow configuration
ralph schema --config <path>

# Initialize template scaffold
ralph init --template <goal|blueprint> [--working-directory <path>] [--force]

# Show introspection info
ralph templates [show]
ralph variables [show]   # alias: vars
ralph actions [show]
ralph predicates [show]
ralph triggers [show]
ralph schema [show]
ralph explain action <name>
ralph explain predicate <name>
ralph explain trigger <name>
```

---

## Deterministic Verification & Quality Gates

Deterministic scripts live under `.agentic/scripts/`:

- **`build.js`**: Runs TypeScript compilation (`tsc -p .`). On failure, captures error to `.agentic/__build.log` and exits 1. On success, removes `.agentic/__build.log`.
- **`test.js`**: Runs Vitest with coverage. On failure, captures log to `.agentic/__test.log` and exits 1. On success, cleans `__test.log`, checks line/branch coverage against `.agentic/coverage.json`. If coverage decreased, fails and schedules improvement task.

---

## Self-Hosting & Bootstrapping Strategy

1. **Bootstrap 0 (Bare-bones MVP)**: Compiled using `tsc` to produce executable JS in `bootstrap/ralph.js`.
2. **Self-Hosting Iteration**: Stable build is copied to `bootstrap/`. Subsequent development tasks are orchestrated using `node bootstrap/ralph.js run --config .agentic/ralph.yaml`.
3. **Continuous Verification**: Each task runs build, test, coverage, and lint verification via `postAgent` scripts.
