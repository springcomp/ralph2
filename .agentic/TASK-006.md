# TASK-006 — Migrate executable samples and architecture docs

## Objective
Make examples and documentation teach separated goal intent, canonical queue naming, compatibility aliases, and completion ownership.

## Implementation
1. Migrate `samples/goal/`:
   - rename task state fixture to `queue.md`;
   - add `GOAL.md`;
   - update YAML, agent prompt, and goal workflow wording;
   - retain existing failure-log producer behavior.
2. Migrate `samples/blueprint/`, `samples/blueprint-watcher/`, and `samples/schema.v1.yaml` to `tasks.queue`, queue files, and `{QUEUE}` wording.
3. Update `README.md`, `CONTRIBUTING.md`, `DESIGN.md`, and `plans/CORE_LOOP.md`:
   - distinguish user-owned `GOAL.md` from Ralph-owned task queue;
   - document `tasks.prd` / `{PRD}` aliases and deprecation direction;
   - explain engine-owned vs agent-owned completion;
   - explain generated assignment prompt;
   - describe blueprint as intentional human-authored queue workflow.

## Acceptance criteria
- All runnable samples refer to files that exist and use canonical queue configuration.
- Goal sample contains real editable goal-intent guidance.
- No first-party documentation presents generated-goal queue as product requirements.
- Documentation accurately states legacy aliases remain supported.
- Blueprint sample docs retain correct manual task authoring instructions.
