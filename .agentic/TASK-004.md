# TASK-004 - Add end-to-end empty-PRD regression coverage

## Objective

Prove that a fresh goal workflow with an empty PRD processes the configured seed task instead of exiting immediately, and that completion does not create an unintended second task.

## Implementation steps

1. Identify the smallest existing CLI or integration harness that can run a compiled goal workflow with a fake process runner/task source.
2. Create an empty PRD fixture and configure the goal continuation with a literal `seedTask`.
3. Run the workflow and assert the seeded task reaches the pipeline.
4. Assert the task is checked or otherwise processed according to the normal workflow path.
5. Assert the workflow does not report immediate empty-PRD completion before processing the seed.
6. Exercise the completed-initial-goal path and verify no second seed is inserted within the same run.
7. Keep tests deterministic and avoid invoking a real external AI harness.

## Acceptance criteria

- [ ] Empty-PRD goal run processes one initial seeded task.
- [ ] The seed task is visible to normal pipeline steps and verification.
- [ ] A successful initial goal does not cause an extra generated task.
- [ ] Existing non-empty goal workflows retain their current execution behavior.
- [ ] Regression test passes with the project’s normal test command.

## Tests

- Add or update an integration/CLI test under `tests/integration` or the existing CLI test suite.
- Use fake runners and temporary workspace files where needed.
- Run the focused integration test before the full suite.
