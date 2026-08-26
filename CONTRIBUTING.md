# Contributing to Ralph

Welcome! This guide explains how to develop, test, and bootstrap `ralph`.

Ralph uses self-hosting: every new feature and bugfix is developed and verified using `ralph` itself running in a continuous loop.

---

## Prerequisites

- **Node.js**: `v20.x` or later (LTS recommended)
- **pnpm**: `v9.x` or later
- **AI Harness CLI**: `pi` or `copilot` installed in your `PATH`

---

## Repository Setup & Seeding Workflow

To start developing or contributing features to Ralph:

### 1. Clone the Repository

```bash
git clone https://github.com/springcomp/ralph.git
cd ralph
```

### 2. Install Dependencies & Build Initial Version

```bash
pnpm install
pnpm build
pnpm test
```

### 3. Seed the Bootstrap Binary

The `bootstrap/` folder contains the stable, self-hosting runner used to orchestrate subsequent development cycles.

Compile and seed the initial bootstrap binary:

```bash
pnpm run seed:bootstrap
```

*(This compiles TypeScript into `dist/` and copies the executable bundle into `bootstrap/ralph.js`)*

### 4. Schedule New Work via Blueprint

Add human-authored tasks to `.agentic/BLUEPRINT.md`:

```bash
echo "- [ ] TASK-001 - Create a simple `index.js` script that prints "hello, world!" (model: \`gemini-3.7-flash\`)" >> .agentic/BLUEPRINT.md
```

### 5. Cook with Ralph

Run the self-hosting Ralph runner on the workspace:

```bash
node bootstrap/ralph.js run --config .agentic/ralph.yaml
```

Ralph will:

1. Seed the task from `BLUEPRINT.md` into Ralph's `queue.md`.
2. Invoke the agent harness with a fresh context window.
3. Run deterministic verification (`build.js`, `test.js`, coverage comparison).
4. Auto-schedule `FIX-xxx` tasks if any check fails.
5. Advance to the next task upon successful completion. Blueprint agents check completed queue tasks; goal workflows leave queue state and completion to Ralph's engine.

---

## Development Scripts

| Command | Description |
| --- | --- |
| `pnpm build` | Compile TypeScript source code with `tsc` |
| `pnpm test` | Run unit and integration tests with Vitest |
| `pnpm test:coverage` | Run test suite with V8 code coverage report |
| `pnpm lint` | Lint and check formatting with Biome |
| `pnpm format` | Auto-format codebase with Biome |
| `pnpm typecheck` | Run `tsc --noEmit` to verify type safety |
| `pnpm seed:bootstrap` | Build and copy current stable version to `bootstrap/` |

---

## Quality Gates & Verification Checks

Every iteration runs automated checks defined in `.agentic/ralph.yaml`:

- **Build Check (`.agentic/scripts/build.js`)**:
  - Compiles the project.
  - If errors occur, logs them to `.agentic/__build.log` and triggers immediate scheduling of `FIX-{ITERATION:000}`.
- **Test & Coverage Check (`.agentic/scripts/test.js`)**:
  - Executes Vitest test suite and extracts line/branch coverage.
  - If tests fail, logs them to `.agentic/__test.log` and schedules a fix task.
  - If coverage drops below the baseline recorded in `.agentic/coverage.json`, the check fails to enforce test coverage maintenance.

---

## Code Guidelines

- **TypeScript**: Strict type checking enabled (`strict: true`, `noImplicitAny: true`).
- **Formatting & Linting**: Managed by Biome (`biome.json`). Run `pnpm format` before committing.
- **Process Safety**: Never execute shell strings or raw string concatenation for child process arguments. Always pass explicit argument arrays (`argv`).
- **Atomic File Operations**: Mutate PRD and Blueprint files through `StateLock` (compare-and-swap) to guarantee state integrity.
