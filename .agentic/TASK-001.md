# TASK-001 - Add optional seedTask continuation configuration

## Objective

Add an optional literal `seedTask` property to generated-goal continuation configuration. The property must flow through schema validation and compiler lowering without changing existing continuation behavior.

## Implementation steps

1. Update the workflow continuation schema in `src/config/schema.ts` (and any related v1 DTO typing in `src/config/schema-v1.ts`) to recognize `seedTask` as an optional string with `minLength: 1`.
2. Preserve the current validation rules for `kind`, `producer`, `completeWhen`, and `nextTask`.
3. Add `seedTask?: string` to the continuation portion of `WorkflowPlan` in `src/config/compiler.ts`.
4. Read `continuationDto.seedTask` during compilation using the same text normalization used for `nextTask`.
5. Ensure an omitted `seedTask` remains `undefined`, while whitespace/empty or non-string values fail validation.
6. Do not expand placeholders in `seedTask`; it must be retained as literal task text.
7. Keep unknown/custom continuation properties working as before.

## Acceptance criteria

- [x] A continuation with a valid non-empty `seedTask` passes validation.
- [x] Empty, whitespace-only, and non-string `seedTask` values are rejected with normal workflow diagnostics.
- [x] Compiled plans expose the exact configured `seedTask` text.
- [x] Compiled plans omit or leave `seedTask` undefined when it is not configured.
- [x] Existing continuation configurations compile unchanged.
- [x] `nextTask` retains its existing placeholder-capable behavior.

## Tests

- [x] Add compiler/schema tests for valid, omitted, empty, whitespace, and non-string `seedTask` values.
- [x] Assert the compiled plan contains literal placeholder text if a placeholder appears in `seedTask`, proving no compile-time expansion occurs.
- [x] Run the focused compiler tests and typecheck.
