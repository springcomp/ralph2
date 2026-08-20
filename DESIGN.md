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
ralph schema [show]
ralph explain action <name>
ralph explain predicate <name>
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
