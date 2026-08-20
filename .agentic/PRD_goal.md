# Product Requirements

Make the `goal` workflow template a registered built-in extension. Preserve the current goal workflow behavior and keep `blueprint` on the legacy template registry for this change. Introduce a reusable named goal producer registration for `continuation.producer` while retaining inline producer commands.

## Tasks

- [ ] T-001 - Define registered template and producer extension contracts (model: `gpt-5.6-luna`)
- [ ] T-002 - Register the built-in goal template and reusable goal producer (model: `gpt-5.6-luna`)
- [ ] T-003 - Resolve named producers during workflow validation and compilation (model: `gpt-5.6-luna`)
- [ ] T-004 - Route CLI template listing and initialization through registered extensions (model: `gpt-5.6-luna`)
- [ ] T-005 - Preserve blueprint compatibility and public extension exports (model: `gpt-5.6-luna`)
- [ ] T-006 - Add registry, configuration, CLI, and workflow regression tests (model: `gpt-5.6-luna`)
- [ ] T-007 - Run formatting, typecheck, lint, and full test validation (model: `gpt-5.6-luna`)

## Implementation Plan

### T-001 - Define registered template and producer extension contracts

Update `src/extensions/registry.ts` with a `TemplateRegistration` contract containing a case-insensitive name and immutable template file map. Add a producer registration contract with a pure `create(): CommandDto` factory that creates the existing process-based producer stage definition without executing a process during registration or compilation. Extend `ExtensionRegistry` with template and producer collections plus lookup methods. Extend `createExtensionRegistry` to accept custom templates and producers, merge them with built-ins, and reject blank or case-insensitive duplicate names.

Acceptance criteria:

- The public types describe template files, producer registrations, and lookup methods.
- Built-in and custom registrations are exposed through one registry instance.
- Duplicate names are rejected case-insensitively for templates and producers.
- Producer factories do not execute producer processes.

### T-002 - Register the built-in goal template and reusable goal producer

Create focused modules under `src/extensions/templates/` and `src/extensions/producers/` that own the goal template files and named producer definition. Preserve the current `ralph.yaml`, prompt, PRD, and progress contents, including the `generatedGoal` continuation, `fileMissing` predicate, marker path, timeout, and next-task placeholder. The producer registration must expose a pure `create(): CommandDto` factory that compiles to the same process-stage shape currently consumed by the engine.

Acceptance criteria:

- The default extension registry contains a `goal` template.
- The default extension registry contains the named goal producer.
- Goal initialization produces the same file names and content as before.
- No goal producer shell command is executed during registry creation or configuration compilation.

### T-003 - Resolve named producers during workflow validation and compilation

Update the configuration DTO/schema, validator, and compiler so `continuation.producer` accepts either a bare registered producer name such as `producer: goalProducer` or the current inline producer command object. Resolve named producers through a reusable command-resolution helper into the existing `StagePlan` consumed by `WorkflowEngine`. Apply that helper only to `continuation.producer` in this change; retain the inline producer command form so existing configurations remain valid. Report an actionable validation error for unknown producer names and preserve normal placeholder, workspace, timeout, and exit-code handling.

Acceptance criteria:

- A goal configuration using `producer: goalProducer` compiles to the existing generated-goal plan shape.
- Unknown producer names fail validation with a path-specific diagnostic at `continuation.producer`.
- Existing inline producer configurations continue to compile unchanged.
- Producer resolution does not alter engine execution semantics.

### T-004 - Route CLI template listing and initialization through registered extensions

Update `src/cli/index.ts` so `createProgram(registry)` uses registered templates for `init --template` and template introspection. Keep the legacy `blueprint` template available exactly once in the combined list and preserve existing command output, unknown-template errors, overwrite protection, and `--force` behavior. Ensure custom templates supplied through `createExtensionRegistry` can be initialized by the CLI.

Acceptance criteria:

- `ralph templates` lists `goal` and `blueprint` once each.
- `ralph init --template goal` resolves the registered built-in template.
- A custom registered template can be initialized through `createProgram(customRegistry)`.
- Unknown names and existing-file conflicts retain current exit-code and error behavior.

### T-005 - Preserve blueprint compatibility and public extension exports

Keep `blueprint` in `src/templates/template-registry.ts` and retain the existing `getTemplate` compatibility behavior for blueprint consumers. Remove or isolate duplicate goal ownership as needed so the registered goal is the source of truth for CLI initialization. Export the new template and producer registration types and registry APIs from the CLI package entry point without breaking existing action and predicate exports.

Acceptance criteria:

- Existing blueprint registry tests remain valid or are updated only for intentional ownership changes.
- Existing action and predicate registration APIs remain source-compatible.
- Public exports expose the new registration contracts.
- The goal template is not maintained as two conflicting content definitions.

### T-006 - Add registry, configuration, CLI, and workflow regression tests

Add focused tests covering built-in and custom template lookup, producer registration, case-insensitive duplicate rejection, unknown producer diagnostics, inline producer compatibility, CLI listing and initialization, blueprint compatibility, and unchanged goal workflow execution. Prefer narrow tests near the owning modules and retain integration coverage in `tests/integration/goal-workflow.test.ts`.

Acceptance criteria:

- Tests cover successful built-in goal registration and custom registration.
- Tests cover duplicate template/producer names and unknown producer references.
- Tests prove generated goal plans retain the current producer stage behavior.
- Tests prove CLI initialization and listing work with both built-in and custom registrations.
- The existing goal workflow integration scenarios continue to pass.

### T-007 - Run formatting, typecheck, lint, and full test validation

Run the repository validation commands after implementation: focused Vitest tests first, then `pnpm typecheck`, `pnpm lint`, and `pnpm test`. Fix only issues caused by this change. Confirm the generated bootstrap artifacts are updated if the repository build workflow requires them.

Acceptance criteria:

- Focused registry/configuration/CLI/goal tests pass.
- `pnpm typecheck` passes.
- `pnpm lint` passes.
- `pnpm test` passes.
- Any required generated artifacts remain consistent with source changes.

## Scope Decisions

- Only `goal` becomes a registered built-in template in this change.
- `blueprint` remains supported through the legacy template registry and remains available in CLI output.
- Continuation kinds and engine lifecycle behavior are unchanged.
- Producer execution remains process-based and produces the existing `StagePlan`.
- Inline producer commands remain supported for backward compatibility.
- Future blueprint-built-on-goal composition is out of scope; this change only provides a reusable named producer and a resolution boundary that later work can adopt.
- No external plugin discovery, arbitrary code loading, or template inheritance is included.
