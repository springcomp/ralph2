# Ralph

> A deterministic AI coding loop orchestrator.

Ralph automates AI coding harnesses (like Pi or Copilot) by running them in an iterative loop. Each iteration, the agent receives a fresh context window. Deterministic post-agent tasks (build, unit tests, coverage verification) run automatically to **trust, but verify** the agent's work.

---

## Features

- **Self-Healing Loop**: If deterministic checks fail, Ralph immediately schedules remediation tasks (`FIX-xxx`) for the next iteration.
- **Blueprint & Goal Workflows**: Supports step-by-step blueprint progression or goal-driven completion predicates (`fileExists`, `fileMissing`, `acceptedExitCode`).
- **Safe Process Execution**: Pure `argv` array dispatch prevents shell injection and quoting anomalies. Full process-tree termination on timeouts and cancellation.
- **State Integrity**: Workspace and atomic file locks prevent race conditions and corruption across iterations.
- **Model & Agent Fallback Hierarchy**: Resolves models and agents dynamically (`Task Metadata > CLI Options > YAML Defaults`).

---

## Getting started

### 1. Clone the repository

```bash
git clone https://github.com/springcomp/ralph.git
cd ralph
```

### 2. Build + run tests

```bash
pnpm install
pnpm build
pnpm test
```

### 3. Initialize a workspace

```bash
ralph init --working-directory ~/my --template blueprint
```

*(Or alias `--workspace-folder ~/my`)*

### 4. Add new blueprint work

```bash
echo "- [ ] TASK-001 - Create a simple node index.js script that prints \"hello, world!\"" > ~/my/.agentic/BLUEPRINT.md
```

### 5. Cook!

```bash
ralph run --config ~/my/.agentic/ralph.yaml
```

---

## CLI Reference

```text
Usage:
  ralph run      --config <path> [--model <model>] [--agent <agent>] [--harness <name>] [--max-iterations <n>] [--working-directory <path>] [--plain]
  ralph validate --config <path> [--model <model>] [--agent <agent>] [--harness <name>] [--max-iterations <n>] [--working-directory <path>]
  ralph init     --template <goal|blueprint> [--working-directory <path>] [--force]
  ralph show     --variables|--vars
  ralph show     --templates
```

### Exit Codes

| Code | Status | Description |
|---:|---|---|
| `0` | `Complete` | Workflow finished successfully or configuration is valid. |
| `2` | `InvalidConfiguration` | Invalid CLI arguments or YAML schema violations. |
| `3` | `Blocked` | Workspace lock contention, ambiguous state, or verification failure. |
| `4` | `IterationLimitReached` | Maximum iteration count reached. |
| `5` | `ProcessFailure` | Command execution error, process timeout, or cancellation. |

---

## Tech Stack

- **Runtime**: Node.js (>=20) & TypeScript
- **CLI**: Commander.js
- **Testing**: Vitest + V8 coverage
- **Formatting & Linting**: Biome

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for details on the self-hosting development workflow and testing guidelines.

## Architecture

See [DESIGN.md](DESIGN.md) for detailed architectural specifications.
