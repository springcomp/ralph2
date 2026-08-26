# TASK-003 - Update the goal template to use seedTask

## Objective

Make the goal template install an empty PRD and configure its initial goal through the generated-goal continuation.

## Implementation steps

1. Add `seedTask` to the goal continuation YAML in `src/extensions/templates/goal.ts`.
2. Use the existing starter task as the literal default seed: `- [ ] GOAL-001 - Define first goal`.
3. Remove the starter task from the goal template's `PRD.md` fixture, leaving the product-requirements heading and blank content.
4. Do not put `{ITERATION}`, `{TASK}`, or other placeholders in `seedTask`.
5. Keep the existing generated `nextTask` template for goals created after the initial task.
6. Check whether generated/bootstrap template artifacts are committed and regenerate them if required by repository conventions.

## Acceptance criteria

- [ ] Fresh goal initialization creates an empty PRD apart from its heading.
- [ ] Goal YAML contains the literal configured `seedTask`.
- [ ] The default seed task matches the current starter task text.
- [ ] Subsequent generated goals still use the existing `nextTask` expression.
- [ ] Blueprint template behavior remains unchanged unless it intentionally derives from the updated goal files.

## Tests

- Update registry/template tests to assert the empty PRD and configured seed task.
- Verify goal and blueprint template registrations still expose required files.
- Run template-focused tests and inspect generated artifacts when applicable.
